// JobSimp service worker: message router (Controller).
// Model: src/dao/<resource>.js classes (get/post/put/delete).

import {
  draftEmail, personalizeBody, appendSignature, ensureNamePlaceholder, generalizeGreeting,
} from '../service/email.js';
import { parseResume } from '../service/resume.js';
import { sendEmail, b64, isAuthFailure } from '../service/gmail.js';
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
});

chrome.alarms?.clear?.('jobsimp-poll');
chrome.alarms?.clear?.('jobsimp-sync');
resume.warm().catch((e) => console.warn('dao warm failed', e.message));

// ---------- ephemeral-store hygiene (transactions + jdgraphs are TTL'd) ----------
const cleanupEphemeral = () => Promise.all([transaction.cleanup(), jdgraph.cleanup()])
  .catch((e) => console.warn('ephemeral cleanup failed', e.message));
cleanupEphemeral();
chrome.alarms?.create?.('jobsimp-ttl', { periodInMinutes: 24 * 60 });
chrome.alarms?.onAlarm?.addListener((a) => { if (a.name === 'jobsimp-ttl') cleanupEphemeral(); });

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

// ---------- Sent-folder beacon GIF gate (DNR) ----------
// Blocks direct browser loads of /beacon/pixel/*.gif while the tab is on Gmail Sent.
// (JSON track GETs are not resourceType "image", so badges still work.)
const sentGateRuleByTab = new Map(); // tabId → ruleId
let sentGateNextId = 61001;

function isGmailSentUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/mail\.google\.com$/i.test(u.hostname) && !u.hostname.endsWith('.mail.google.com')) {
      return false;
    }
    const h = decodeURIComponent(u.hash || '');
    return /#sent\b/i.test(h) || /#label\/sent\b/i.test(h);
  } catch {
    return false;
  }
}

async function setSentBeaconGate(tabId, enabled) {
  if (!chrome.declarativeNetRequest?.updateSessionRules || tabId == null) return;
  const existing = sentGateRuleByTab.get(tabId);
  const removeRuleIds = existing != null ? [existing] : [];
  const addRules = [];
  if (enabled) {
    const id = existing != null ? existing : sentGateNextId++;
    sentGateRuleByTab.set(tabId, id);
    addRules.push({
      id,
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: '||api-galzsvftoq-uc.a.run.app/v1/api/beacon/pixel/',
        resourceTypes: ['image', 'other'],
        tabIds: [tabId],
      },
    });
  } else if (existing != null) {
    sentGateRuleByTab.delete(tabId);
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
    // #region agent log
    fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6d61a9'},body:JSON.stringify({sessionId:'6d61a9',runId:'post-fix',hypothesisId:'H1',location:'service-worker.js:setSentBeaconGate',message:'DNR sent gate',data:{tabId,enabled,ruleId:sentGateRuleByTab.get(tabId)||null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  } catch (e) {
    console.warn('[beacon] sent DNR gate failed', e?.message || e);
  }
}

function syncSentBeaconGateFromUrl(tabId, url) {
  return setSentBeaconGate(tabId, isGmailSentUrl(url));
}

const onMailNav = (d) => {
  if (d.frameId !== 0 || !d.url || !/mail\.google\.com/i.test(d.url)) return;
  syncSentBeaconGateFromUrl(d.tabId, d.url);
};
chrome.webNavigation?.onCommitted?.addListener(onMailNav);
chrome.webNavigation?.onHistoryStateUpdated?.addListener(onMailNav);
chrome.webNavigation?.onReferenceFragmentUpdated?.addListener(onMailNav);
chrome.tabs?.onRemoved?.addListener((tabId) => {
  setSentBeaconGate(tabId, false).catch(() => {});
});

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

/** Send one message and persist its log row. Never throws. */
async function sendAndLog({
  to, toName, body, subject, jobId, provider, resumeId, attached, fromName, attachment, beaconId,
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
    rec.gmailId = await sendEmail({ to, subject, body, fromName, attachment, beaconId: beaconId || undefined });
    rec.status = 'sent';
    rec.sentAt = Date.now();
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
  'beacon.reset': (p) => resetBeacon(p?.id),
  'beacon.track': (p) => trackBeacon(p?.id),
  'beacon.pixelHtml': (p) => ({ html: pixelHtml(p?.id), id: p?.id || '' }),
  'beacon.extractId': (p) => extractBeaconId(p?.html || p?.body || ''),
  /** Content script: enable/disable Sent-folder GIF block for this tab. */
  'beacon.sentGate': async (p, _sender) => {
    const tabId = _sender?.tab?.id;
    if (tabId == null) return { ok: false };
    await setSentBeaconGate(tabId, !!p?.on);
    return { ok: true, on: !!p?.on };
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

    let attachment = null;
    let attachError = '';
    if (p.attach) {
      if (!p.resumeId) {
        attachError = 'No resume selected — nothing attached.';
      } else {
        ({ attachment, error: attachError } = await buildResumeAttachment(p.resumeId));
      }
    }
    // Asked for an attachment and we could not build one → stop, do not send a
    // resume-less email the user believes carried their resume.
    if (p.attach && !attachment) throw new Error(attachError || 'Could not attach resume.');

    const reuseId = p.beaconId || extractBeaconId(body) || '';
    const common = {
      subject,
      jobId: p.jobId,
      provider: p.provider,
      fromName: s.gmail?.fromName || '',
      resumeId: p.attach ? p.resumeId : '',
      attached: !!attachment,
      attachment,
    };

    if (group) {
      const toList = list.map((r) => r.email);
      const beaconId = await beaconForSend({
        reuseId,
        meta: { jobId: p.jobId, to: toList.join(', '), source: 'outreach' },
      });
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
      const beaconId = await beaconForSend({
        reuseId: list.length === 1 ? reuseId : '',
        meta: { jobId: p.jobId, to: r.email, source: 'outreach' },
      });
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
