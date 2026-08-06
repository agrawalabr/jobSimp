// JobSimp service worker: message router (Controller).
// Model: src/dao/<resource>.js classes (get/post/put/delete).

import {
  draftEmail, personalizeBody, appendSignature, ensureNamePlaceholder, generalizeGreeting,
} from '../service/email.js';
import { parseResume } from '../service/resume.js';
import { sendEmail, b64, isAuthFailure, hardenSentCopy, findSentMessageByBeacon, getGmailMessage } from '../service/gmail.js';
import { normalizeRecipients, recipientGreetingName } from '../static/recipients.js';
import { getSettings, saveSettings } from '../service/settings.js';
import { signIn, getUser, signOut } from '../service/oauth.js';
import { requestLLM, extractJson } from '../service/llm.js';
import { getJdAnalysis, putJdAnalysis } from '../service/jdCache.js';
import {
  applicationStatus, startApplication, consolidatePage,
  advanceApplication, completeApplication, buildTailored, saveUserAnswer,
} from '../service/apply.js';
import { identityContext } from '../service/identity.js';
import {
  ensureBeacon, trackBeacon, registerBeacon, resetBeacon, pixelHtml, extractBeaconId,
  listPixels, createPixel, patchBeaconMessageId,
} from '../service/beacon.js';
import { JD_ANALYSIS_PROMPT } from '../static/prompts.js';
import { isJobUrl, jobCacheKey, extractJobId, JD_TEXT_LIMIT } from '../static/jobUrl.js';
import { user, profile, metrics, settings, resume, job, answer, email, discovered, transaction, jdgraph, graph } from '../dao/index.js';

chrome.runtime?.onInstalled?.addListener(async (details) => {
  chrome.alarms.clear('jobsimp-poll');
  chrome.alarms.clear('jobsimp-sync');
  const s = await settings.get();
  if (details.reason === 'install' || !s.onboarded) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/component/onboarding/onboarding.html') });
  }
  if (details.reason === 'update' || details.reason === 'install') {
    await reloadGmailTabs('onInstalled:' + details.reason);
  }
});

/** Kill zombie Gmail content scripts after an extension reload / version bump. */
async function reloadGmailTabs(reason) {
  try {
    const ver = chrome.runtime.getManifest?.()?.version || '';
    const key = 'mailTrackReloadedVersion';
    const bag = await chrome.storage.local.get(key);
    if (bag[key] === ver && reason.startsWith('boot')) return;
    await chrome.storage.local.set({ [key]: ver });
    const tabs = await chrome.tabs.query({ url: ['https://mail.google.com/*'] });
    await Promise.all(
      (tabs || []).map((t) => (t.id != null
        ? chrome.tabs.reload(t.id).catch(() => {})
        : Promise.resolve())),
    );
    console.info('[JobSimp] reloaded Gmail tabs after', reason, ver);
  } catch (e) {
    console.warn('[JobSimp] gmail tab reload failed', e?.message || e);
  }
}

// ---------- ephemeral-store hygiene (transactions + jdgraphs are TTL'd) ----------
const cleanupEphemeral = () => Promise.all([transaction.cleanup(), jdgraph.cleanup()])
  .catch((e) => console.warn('ephemeral cleanup failed', e.message));

chrome.alarms?.onAlarm?.addListener((a) => { if (a.name === 'jobsimp-ttl') cleanupEphemeral(); });

/**
 * Defer boot side-effects until after the first event-loop turn so SW
 * registration cannot fail with Chrome's opaque "Failed to load the script
 * unexpectedly" when tabs/alarms/IndexedDB race the module evaluate.
 */
function bootSideEffects() {
  chrome.alarms?.clear?.('jobsimp-poll');
  chrome.alarms?.clear?.('jobsimp-sync');
  chrome.alarms?.create?.('jobsimp-ttl', { periodInMinutes: 24 * 60 });
  resume.warm().catch((e) => console.warn('dao warm failed', e.message));
  cleanupEphemeral();
  // Unpacked "Reload" restarts the SW; bump storage so Gmail tabs pick up new content scripts.
  reloadGmailTabs('boot').catch(() => {});
}
queueMicrotask(bootSideEffects);

// Per-tab application context: set on Apply click, read by the injected autofill.
// In-memory is fine — it's re-set on every Apply click if the SW restarts.
const applyCtxByTab = new Map();

// ---------- inject the widget on SPA navigations ----------
// Content scripts only auto-run on a full document load. Single-page apps
// (LinkedIn, Workday, Greenhouse embeds…) change the URL via history.pushState
// with no reload, so Chrome never (re)injects — the badge would only appear
// after a manual refresh. Re-inject on history/hash navigations to matching URLs.
// The content script guards itself against double-injection, so this is a no-op
// when it's already running on the tab.
if (chrome.webNavigation?.onHistoryStateUpdated) {
  const onSpaNav = (d) => {
    if (d.frameId !== 0 || !isJobUrl(d.url)) return;
    chrome.scripting.executeScript({ target: { tabId: d.tabId }, files: ['src/content/bootstrap.js'] }).catch(() => {});
  };
  chrome.webNavigation.onHistoryStateUpdated.addListener(onSpaNav);
  chrome.webNavigation.onReferenceFragmentUpdated?.addListener(onSpaNav);
}

function removedStorage(name) {
  throw new Error(`${name} removed. Use src/dao/ (IndexedDB jobsimp-graph).`);
}

// ---------- outreach send helpers ----------
const RESUME_EXT = [
  [/pdf/, '.pdf'],
  [/word|officedocument|document/, '.docx'],
  [/text/, '.txt'],
];

/**
 * Build the Gmail attachment part from a stored resume.
 * Returns { attachment, error } — an error here must NOT silently degrade into
 * "sent without the resume", because the whole point of the send was the resume.
 */
async function buildResumeAttachment(resumeId) {
  const r = await resume.get(resumeId);
  if (!r) return { attachment: null, error: 'Resume not found — sent nothing.' };

  const base = String(r.name || 'resume').replace(/\.(pdf|docx|txt)$/i, '');
  if (r.dataB64) {
    const mime = r.mime || 'application/octet-stream';
    const ext = RESUME_EXT.find(([re]) => re.test(mime))?.[1] || '.bin';
    return { attachment: { filename: `${base}${ext}`, mime, dataB64: r.dataB64 }, error: null };
  }
  if (r.text) {
    return {
      attachment: { filename: `${base}.txt`, mime: 'text/plain', dataB64: b64(r.text) },
      error: null,
    };
  }
  return { attachment: null, error: 'Resume has no file or text to attach.' };
}

/**
 * Register or reset a beacon for this send. Fail-soft: returns '' on error
 * so the email still goes out (Sent UI will show Untracked).
 */
async function beaconForSend({ reuseId, meta }) {
  try {
    const payload = await ensureBeacon({ id: reuseId || undefined, meta });
    return payload?.id || '';
  } catch (e) {
    console.warn('[beacon] ensure failed', e.message);
    return '';
  }
}

// ---------- beacon <-> Gmail message id (exact Sent-row matching) ----------
//
// Gmail's own Sent-list rows expose a native message id in the DOM
// (data-legacy-last-non-draft-message-id) — the same id format
// hardenSentCopy's insert step returns. The moment hardening confirms a
// beacon's final Gmail message id, attach it to that beacon's own meta via
// patchBeaconMessageId — beacon.list then returns meta.gmailMessageId
// directly, so the content script can build an exact match index straight
// from docs it already fetches, no separate lookup needed.

async function recordBeaconMessageId(beaconId, gmailMessageId) {
  if (!beaconId || !gmailMessageId) return;
  try {
    await patchBeaconMessageId(beaconId, gmailMessageId);
  } catch (e) {
    console.warn('[beacon] recordBeaconMessageId failed', e.message);
  }
}
//
// A "Schedule send" click queues the message in Gmail without sending it —
// it can sit there for hours or days, and may fire long after this browser
// session (even after a restart). The pixel has to be baked into the body
// at schedule-click time (that's the content that eventually goes out),
// but registering the beacon then would be premature: the message hasn't
// actually been sent, may still be edited/cancelled from the queue, and
// hardenSentCopy would have nothing to find yet. So registration is
// deferred to a periodic alarm that checks whether each pending watch has
// actually landed in Sent — reusing the same search-then-verify approach
// findSentMessageByBeacon already uses for the immediate-send flow.
//
// Persisted in chrome.storage.local rather than the IndexedDB dao layer:
// this is a small, short-lived, unindexed queue, not a real resource.

const SCHEDULED_WATCH_KEY = 'jobsimp_scheduled_beacon_watches';
const SCHEDULED_ALARM = 'jobsimp-scheduled-beacon-check';
const SCHEDULED_WATCH_MAX_AGE_MS = 32 * 24 * 3600 * 1000; // past Gmail's schedule horizon

async function getScheduledWatches() {
  const got = await chrome.storage.local.get(SCHEDULED_WATCH_KEY);
  const list = got?.[SCHEDULED_WATCH_KEY];
  return Array.isArray(list) ? list : [];
}

async function setScheduledWatches(list) {
  await chrome.storage.local.set({ [SCHEDULED_WATCH_KEY]: list });
}

async function ensureScheduledAlarm() {
  const existing = await chrome.alarms.get(SCHEDULED_ALARM);
  if (!existing) chrome.alarms.create(SCHEDULED_ALARM, { periodInMinutes: 10 });
}

async function checkScheduledWatches() {
  const watches = await getScheduledWatches();
  if (!watches.length) {
    await chrome.alarms.clear(SCHEDULED_ALARM);
    return;
  }
  const remaining = [];
  for (const w of watches) {
    if (Date.now() - (w.addedAt || 0) > SCHEDULED_WATCH_MAX_AGE_MS) {
      console.warn('[beacon] scheduled watch expired without confirming send', w.beaconId);
      continue; // drop — well past any realistic Gmail schedule horizon
    }
    let found = null;
    try {
      found = await findSentMessageByBeacon(w.beaconId, { to: w.to, retries: 1, delayMs: 0 });
    } catch (e) {
      console.warn('[beacon] scheduled watch search failed', w.beaconId, e.message);
    }
    if (!found) {
      remaining.push(w); // still queued (or not yet indexed) — check again next cycle
      continue;
    }
    // Actually sent now — register the beacon at real send time, then harden.
    try {
      await createPixel({ id: w.beaconId, count: 0, meta: w.meta });
    } catch (e) {
      console.warn('[beacon] scheduled watch: createPixel failed', w.beaconId, e.message);
      remaining.push(w); // retry next cycle rather than losing tracking silently
      continue;
    }
    hardenSentCopy(found).then((r) => {
      if (!r.ok) console.warn('[beacon] scheduled hardening skipped', w.beaconId, r.reason);
      else if (r.id) recordBeaconMessageId(w.beaconId, r.id).catch(() => {});
    }).catch((e) => console.warn('[beacon] scheduled hardening threw', e.message));
  }
  await setScheduledWatches(remaining);
  if (!remaining.length) await chrome.alarms.clear(SCHEDULED_ALARM);
}

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name !== SCHEDULED_ALARM) return;
  checkScheduledWatches().catch((e) => console.warn('[beacon] scheduled check failed', e.message));
});

/** Send one message and persist its log row. Never throws. */
async function sendAndLog({
  to, toName, body, subject, jobId, provider, resumeId, attached, fromName, attachments, beaconId,
}) {
  const toStr = Array.isArray(to) ? to.join(', ') : to;
  const bid = beaconId || '';
  const rec = {
    jobId: jobId ?? null,
    to: toStr,
    toName,
    subject,
    body,
    provider: provider || '',
    resumeId: resumeId || '',
    attached: !!attached,
    beaconId: bid,
    jobsimp: bid ? { subject: subject || '', to: toStr || '', beaconId: bid } : undefined,
    status: 'draft',
  };
  try {
    const sent = await sendEmail({
      to, subject, body, fromName, attachments, beaconId: beaconId || undefined,
    });
    rec.gmailId = sent.id;
    rec.status = 'sent';
    rec.sentAt = Date.now();
    if (beaconId) {
      hardenSentCopy({ id: sent.id, threadId: sent.threadId }).then((r) => {
        if (!r.ok) console.warn('[beacon] outreach hardening skipped', rec.gmailId, r.reason);
        else if (r.id) recordBeaconMessageId(beaconId, r.id).catch(() => {});
      }).catch((e) => console.warn('[beacon] outreach hardening threw', e.message));
    }
  } catch (e) {
    rec.status = 'failed';
    rec.error = e.message;
  }
  await email.post(rec);
  return { to: rec.to, status: rec.status, error: rec.error || '', beaconId: rec.beaconId || '' };
}

// ---------- message router ----------
const handlers = {
  'job.save': (p) => job.post(p),
  'job.list': () => job.get(),
  'job.delete': (p) => job.delete(p.id),
  'profile.get': () => profile.view(),
  'profile.set': (p) => profile.setKey(p.key, p.value),
  'profile.update': (p) => profile.put(p),
  'metrics.get': () => metrics.get(),
  'metrics.update': (p) => metrics.put(p),
  'answers.list': () => answer.get(),
  'answers.save': (p) => answer.post(p),
  'answers.delete': (p) => answer.delete(p.id),
  'emails.list': () => email.get(),
  /** Fetch a Sent message from Gmail for the Outreach reading pane. */
  'email.getGmail': (p) => getGmailMessage(p?.gmailId || p?.id),
  /** Upsert outreach/webmail tracking log. Dedupes by beaconId. */
  'emails.post': async (p = {}) => {
    const beaconId = String(p.beaconId || p.jobsimp?.beaconId || '').trim();
    const subject = p.subject ?? p.jobsimp?.subject ?? '';
    const to = p.to ?? p.jobsimp?.to ?? '';
    const jobsimp = beaconId
      ? {
        subject: p.jobsimp?.subject ?? subject,
        to: p.jobsimp?.to ?? to,
        beaconId,
      }
      : (p.jobsimp || undefined);
    if (beaconId) {
      const existing = await email.findByBeacon(beaconId);
      if (existing) {
        if (existing.jobsimp?.beaconId && existing.beaconId) return existing;
        return email.post({
          id: existing.id,
          to: to || existing.to,
          subject: subject || existing.subject,
          beaconId,
          status: p.status || existing.status || 'sent',
          provider: p.provider || existing.provider || '',
          sentAt: p.sentAt ?? existing.sentAt ?? Date.now(),
          jobsimp,
        });
      }
    }
    return email.post({
      ...p,
      to,
      subject,
      beaconId,
      jobsimp,
      status: p.status || 'sent',
      sentAt: p.sentAt ?? Date.now(),
    });
  },
  'beacon.ensure': (p) => ensureBeacon({ id: p?.id, meta: p?.meta }),
  'beacon.register': (p) => registerBeacon({ id: p?.id, meta: p?.meta }),
  'beacon.create': (p) => createPixel(p),
  'beacon.list': (p) => listPixels({ from: p?.from || p?.meta?.from }),
  'beacon.reset': (p) => resetBeacon(p?.id),
  'beacon.track': (p) => trackBeacon(p?.id),
  'beacon.pixelHtml': (p) => ({ html: pixelHtml(p?.id), id: p?.id || '' }),
  'beacon.extractId': (p) => extractBeaconId(p?.html || p?.body || ''),
  /**
   * Content script: harden the Sent-folder copy after a native Gmail
   * compose send. We never get a message id from that send (Gmail's own UI
   * does the actual send call) so we have to find it first via the beacon
   * id already embedded in the body, then strip+trash+reinsert.
   */
  'beacon.hardenSent': async (p) => {
    const beaconId = String(p?.beaconId || '').trim();
    if (!beaconId) return { ok: false, reason: 'no beaconId' };
    const found = await findSentMessageByBeacon(beaconId, { to: p?.to });
    if (!found) {
      console.warn('[beacon] mail-track hardening skipped', beaconId, 'sent message not found');
      return { ok: false, reason: 'sent message not found (search timed out)' };
    }
    const result = await hardenSentCopy(found);
    if (!result.ok) console.warn('[beacon] mail-track hardening skipped', beaconId, result.reason);
    else if (result.id) recordBeaconMessageId(beaconId, result.id).catch(() => {});
    return result;
  },
  /**
   * Content script: a "Schedule send" click was detected — the pixel is
   * already baked into the queued message, but registration is deferred
   * until checkScheduledWatches() confirms it actually left the queue.
   */
  'beacon.watchScheduled': async (p) => {
    const beaconId = String(p?.beaconId || '').trim();
    if (!beaconId) return { ok: false, reason: 'no beaconId' };
    const watches = await getScheduledWatches();
    if (!watches.some((w) => w.beaconId === beaconId)) {
      watches.push({
        beaconId, to: p?.to || [], meta: p?.meta || {}, addedAt: Date.now(),
      });
      await setScheduledWatches(watches);
    }
    await ensureScheduledAlarm();
    return { ok: true };
  },
  'discovered.list': () => discovered.get(),
  'discovered.update': (p) => discovered.put(p),
  'settings.get': () => getSettings(),
  'settings.save': (p) => saveSettings(p),
  'defaults.get': () => settings.getView(),
  'defaults.save': async (p) => { await settings.putView(p); return settings.getView(); },
  'defaults.update': (p) => settings.putView(p),

  'auth.signin': async () => {
    const u = await signIn();
    if (u) await user.post(u);
    return u;
  },
  'auth.get': () => getUser(),
  'auth.signout': () => signOut(),
  'onboarding.complete': async () => {
    const u = await getUser();
    if (u) await user.post(u);
    await profile.get();
    await metrics.get();
    await settings.put({ onboarded: true });
    return true;
  },
  'open.onboarding': async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/component/onboarding/onboarding.html') });
    return true;
  },

  'resumes.list': () => resume.get(),
  'resumes.get': (p) => resume.get(p.id),
  'resumes.save': (p) => resume.post(p),
  'resumes.saveParsed': (p) => resume.saveParsed(p.id, p.parsed, p.parsedAt || Date.now()),
  'resumes.delete': (p) => resume.delete(p.id),
  'resumes.setDefault': (p) => resume.setDefault(p.id),
  'resumes.select': (p) => resume.select(p.id ?? p.ref),
  'resumes.active': () => resume.active(),
  'resumes.parse': async (p) => {
    const r = await resume.get(p.id);
    if (!r) throw new Error('Resume not found');
    const d = await settings.getView();
    const parsed = await parseResume(
      { text: r.text, dataB64: r.dataB64, mime: r.mime },
      d.llm.model,
      d.llm.keys[d.llm.provider],
      d.llm.provider,
    );
    await resume.saveParsed(r.id, parsed, Date.now());
    return parsed;
  },

  'entity.put': () => removedStorage('entity.*'),
  'entity.get': () => removedStorage('entity.*'),
  'entity.query': () => removedStorage('entity.*'),
  'entity.delete': () => removedStorage('entity.*'),
  'graph.build': () => removedStorage('graph.* — use resumes.saveParsed / dao'),
  'graph.overlap': () => removedStorage('graph.*'),
  'graph.selectBullets': () => removedStorage('graph.*'),
  'sync.now': () => removedStorage('sync.*'),
  'sync.status': () => removedStorage('sync.*'),
  'poll.now': () => { throw new Error('Background job polling removed. Discoveries come from the on-page widget.'); },

  '__autofill_result': (p, sender) => {
    if (sender?.tab?.id) chrome.tabs.sendMessage(sender.tab.id, { type: '__autofill_result', payload: p }).catch(() => {});
    return true;
  },
  'autofill.here': async (p, sender) => {
    const tabId = sender?.tab?.id ?? p?.tabId; // panel has no sender.tab → pass tabId explicitly
    if (!tabId) throw new Error('No tab context');
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/autofill.js'] });
    return true;
  },

  // ---------- application engine (phase 2) ----------
  'application.status': (p) => applicationStatus(p.jobKey || jobCacheKey(p.url || '', p.jobId || '')),
  'application.start': async (p, sender) => {
    const tabId = sender?.tab?.id;
    const out = await startApplication(p);
    if (out.alreadyApplied) return out;
    if (tabId) applyCtxByTab.set(tabId, { jobKey: out.jobKey, resumeId: out.resumeId, mode: p.mode || 'apply', jd: p.jd || {} });
    if (p.mode === 'tailored') await buildTailored({ jobKey: out.jobKey, resumeId: out.resumeId, jd: p.jd || {} });
    return out;
  },
  'application.context': (p, sender) => applyCtxByTab.get(sender?.tab?.id) || null,
  'page.consolidate': (p) => consolidatePage(p),
  'application.advance': (p) => advanceApplication(p),
  'application.userAnswer': (p) => saveUserAnswer(p),
  'application.complete': async (p, sender) => {
    if (sender?.tab?.id) applyCtxByTab.delete(sender.tab.id);
    return completeApplication(p);
  },
  'tailor.get': async (p) => (await transaction.get(p.jobKey, p.resumeId))?.tailored || null,

  'jd.analyze': async (p) => {
    const s = await getSettings();
    const { provider, model, keys } = s.ai || {};
    const key = keys?.[provider];
    if (!key) throw new Error(`No API key set for ${provider || 'your provider'}. Add one in Options.`);
    const r = await resume.active(p.resumeId || resume.activeId());
    if (!r?.parsed) throw new Error('Select a parsed resume first.');

    const jobId = p.jobId || extractJobId(p.url || '') || '';
    const jobKey = p.jobKey || jobCacheKey(p.url || '', jobId);
    const resumeId = r.id;

    if (!p.force) {
      const cached = await getJdAnalysis(jobKey, resumeId);
      if (cached) return { ...cached, cached: true, jobId, jobKey };
    }

    const parsed = r.parsed;
    const resumeLite = JSON.stringify({
      skills: parsed.skills || [],
      experiences: (parsed.experiences || []).map((e) => ({ role: e.role, company: e.company, description: String(e.description || '').slice(0, 400) })),
      projects: (parsed.projects || []).map((pr) => ({ name: pr.name, description: String(pr.description || '').slice(0, 300) })),
      education: parsed.education || [],
    });

    const meta = `URL: ${p.url || ''}\nJobId: ${jobId || '—'}\nSource: ${p.source || ''}\nAlready-detected fields: ${JSON.stringify(p.job || {})}`;
    const prompt = `${JD_ANALYSIS_PROMPT}\n\n=== JOB PAGE METADATA ===\n${meta}\n\n=== JOB DESCRIPTION ===\n${String(p.jdText || '').slice(0, JD_TEXT_LIMIT)}\n\n=== CANDIDATE RESUME (JSON) ===\n${resumeLite}`;

    const raw = await requestLLM({ provider, model, key, prompt, config: { temperature: 0, maxTokens: 2400 } });
    const out = extractJson(raw);
    if (!out) throw new Error('Model did not return parseable JSON.');
    const payload = { ...out, cached: false, jobId, jobKey };
    await putJdAnalysis(jobKey, resumeId, { job: out.job, match: out.match, analysis: out.analysis });
    // Persist the requirements graph (feeds field resolution + tailoring until purge).
    await jdgraph.put(jobKey, {
      requirements: out.requirements || [],
      job: out.job, match: out.match, analysis: out.analysis, resumeId,
    });
    return payload;
  },

  'ai.draft': async (p) => {
    const s = await getSettings();
    const active = await resume.active(p.resumeId);
    const identity = await identityContext(active);
    const parsed = active?.parsed || {};
    identity.summary = parsed.summary || identity.basics?.summary || '';

    // Optional resume graph nodes (skills / roles) — keep tiny.
    if (active?.id) {
      const g = await graph.get(active.id);
      if (g?.nodes?.length) {
        const skillLabels = g.nodes
          .filter((n) => String(n.kind || '').toUpperCase() === 'SKILL')
          .slice(0, 20)
          .map((n) => n.props?.label || n.props?.normKey)
          .filter(Boolean);
        if (skillLabels.length) {
          identity.skills = [...new Set([...(identity.skills || []), ...skillLabels])].slice(0, 30);
        }
      }
    }

    let jdGraph = null;
    let jobRow = null;
    if (p.jobId) {
      jobRow = await job.get(p.jobId);
      if (jobRow?.url) {
        const key = jobCacheKey(jobRow.url, jobRow.externalJobId || '');
        const g = await jdgraph.get(key);
        if (g) {
          jdGraph = {
            ...jdgraph.extract(g),
            mustHave: (g.requirements || []).filter((r) => r.importance === 'must').slice(0, 8).map((r) => r.text),
            niceToHave: (g.requirements || []).filter((r) => r.importance === 'nice').slice(0, 5).map((r) => r.text),
          };
        }
      }
      if (!jdGraph && jobRow?.jdExtract) jdGraph = jobRow.jdExtract;
    }

    const recipients = normalizeRecipients(p.recipients || []);
    console.info('[ai.draft] calling LLM', {
      provider: s.ai?.provider,
      model: s.ai?.model,
      hasKey: !!s.ai?.keys?.[s.ai?.provider],
      recipientCount: recipients.length,
      hasJdGraph: !!jdGraph,
      company: p.company || jobRow?.company || '',
    });
    const out = await draftEmail(s, {
      context: p.context || p.jdText || '',
      company: p.company || jobRow?.company || '',
      role: p.role || jobRow?.role || '',
      tones: p.tones || [],
      recipients,
      group: !!p.group,
      signature: p.signature,
      identity,
      jdGraph,
    });
    if (out?.via !== 'llm') throw new Error('Draft path did not use LLM — reload the extension.');
    return out;
  },

  'email.send': async (p) => {
    const s = await getSettings();
    const list = normalizeRecipients(p.recipients);
    if (!list.length) throw new Error('No valid email addresses found.');

    const subject = String(p.subject || '').trim();
    if (!subject) throw new Error('Subject is required.');
    if (!String(p.body || '').trim()) throw new Error('Body is required.');

    // One message to everyone, or one tailored message each.
    const group = !!p.group && list.length > 1;
    const fanOut = !group && list.length > 1;

    // Signature is applied HERE, not at draft time, so edits to it take effect.
    // The greeting placeholder is re-derived here too: the recipient list can
    // change after drafting, which invalidates the model's draft-time choice.
    let body = String(p.body);
    if (fanOut) body = ensureNamePlaceholder(body);
    if (group) body = generalizeGreeting(body, list.map(recipientGreetingName));
    body = appendSignature(body, p.signature ?? s.emailTemplate?.signature ?? '');

    const attachments = [];
    const wantResume = !!p.attach;
    const fileExtras = Array.isArray(p.fileAttachments)
      ? p.fileAttachments
      : (p.fileAttachment?.dataB64 ? [p.fileAttachment] : []);

    if (wantResume) {
      if (!p.resumeId) throw new Error('No resume selected — nothing attached.');
      const built = await buildResumeAttachment(p.resumeId);
      if (!built.attachment) throw new Error(built.error || 'Could not attach resume.');
      attachments.push(built.attachment);
    }
    for (const f of fileExtras) {
      if (!f?.dataB64) continue;
      attachments.push({
        filename: f.filename || 'attachment',
        mime: f.mime || 'application/octet-stream',
        dataB64: f.dataB64,
      });
    }
    // Asked for file attachments and none resolved → stop.
    if (fileExtras.length && attachments.length === (wantResume ? 1 : 0)) {
      throw new Error('Could not attach file.');
    }

    const wantTrack = p.track !== false;
    const reuseId = wantTrack ? (p.beaconId || extractBeaconId(body) || '') : '';
    const common = {
      subject,
      jobId: p.jobId,
      provider: p.provider,
      fromName: s.gmail?.fromName || '',
      resumeId: wantResume ? p.resumeId : '',
      attached: attachments.length > 0,
      attachments,
    };

    if (group) {
      const toList = list.map((r) => r.email);
      const beaconId = wantTrack
        ? await beaconForSend({
          reuseId,
          meta: { jobId: p.jobId, to: toList.join(', '), source: 'jobSimp' },
        })
        : '';
      return [await sendAndLog({
        ...common,
        to: toList,
        toName: list.map((r) => (recipientGreetingName(r) ? r.text : '')).filter(Boolean).join(', '),
        body: personalizeBody(body, ''),
        beaconId,
      })];
    }

    const results = [];
    for (const r of list) {
      const greeting = recipientGreetingName(r);
      // Fan-out: one beacon per recipient so open counts stay independent.
      const beaconId = wantTrack
        ? await beaconForSend({
          reuseId: list.length === 1 ? reuseId : '',
          meta: { jobId: p.jobId, to: r.email, source: 'jobSimp' },
        })
        : '';
      const out = await sendAndLog({
        ...common,
        to: r.email,
        toName: greeting ? r.text : '',
        body: personalizeBody(body, greeting),
        beaconId,
      });
      results.push(out);

      // A dead OAuth session fails identically for every remaining recipient —
      // and each retry re-opens the Google consent window. Bail out instead.
      if (out.status === 'failed' && isAuthFailure(out.error)) {
        for (const skipped of list.slice(results.length)) {
          results.push({ to: skipped.email, status: 'failed', error: 'Skipped — sign in again and retry.' });
        }
        break;
      }
    }
    return results;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) { sendResponse({ ok: false, error: `Unknown message: ${msg?.type}` }); return false; }
  Promise.resolve(h(msg.payload, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
