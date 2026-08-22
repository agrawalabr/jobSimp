// JobSimp service worker: message router (Controller).
// Model: src/dao/<resource>.js classes (get/post/put/delete).

import { draftEmail, draftLinkedInMessage } from '../email/draft-email.js';
import { parseResume } from '../service/resume.js';
import { b64, getGmailMessage, getGmailThread, getGmailConversation, getGmailThreadMeta, getGmailThreadsMetaBatch, getGmailThreadsFullBatch, getGmailAttachment, getGmailMessageForImport, findSentMessagesBySubject, listGmailSentThreads, trashGmailThread } from '../email/gmail.js';
import { normalizeRecipients, recipientGreetingName, recipientListLabel } from '../static/recipients.js';
import { getSettings, saveSettings } from '../service/settings.js';
import { signIn, getUser, signOut } from '../service/oauth.js';
import { requestLLM, extractJson } from '../service/llm.js';
import { getJdAnalysis, putJdAnalysis } from '../service/jdCache.js';
import {
  applicationStatus, startApplication, consolidatePage,
  advanceApplication, completeApplication, buildTailored, saveUserAnswer,
  resolveOneField, rewriteField,
} from '../service/apply.js';
import { identityContext } from '../service/identity.js';
import {
  trackBeacon, registerBeacon, resetBeacon, pixelHtml, extractBeaconId, cleanEmail,
  listPixels, createPixel, ensureBeacon, patchBeaconMessageId,
} from '../email/beacon.js';
import {
  sendTrackedEmail,
  finalizeNativeSend,
  watchScheduledSend,
  drainEmailTxs,
  installEmailTxAlarms,
  allocBeaconId,
} from '../email/manager.js';
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
  drainEmailTxs().catch((e) => console.warn('[email] onInstalled drain failed', e.message));
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
  // Durable harden→register: wire alarms + drain any txs left from a prior SW life.
  installEmailTxAlarms();
  drainEmailTxs().catch((e) => console.warn('[email] boot drain failed', e.message));
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
  'emails.list': async () => {
    const rows = await email.get();
    return [...rows].sort((a, b) => (
      (Number(b?.lastActivityAt || b?.sentAt || b?.createdAt) || 0)
      - (Number(a?.lastActivityAt || a?.sentAt || a?.createdAt) || 0)
    ));
  },
  /**
   * One Gmail Sent page via users.threads.list (most recent first).
   * Does NOT walk every page — UI drives pagination with nextPageToken.
   * Rows are thread-scoped (never messages.list).
   */
  'emails.syncFromGmailSent': async (p = {}) => {
    const pageSize = Math.min(100, Math.max(1, Number(p?.maxResults) || 25));
    const pageToken = String(p?.pageToken || '').trim();
    const listed = await listGmailSentThreads({ maxResults: pageSize, pageToken });

    const rawRows = [];
    const seenThread = new Set();
    for (const meta of listed.threads) {
      const threadId = String(meta?.id || '').trim();
      if (!threadId || seenThread.has(threadId)) continue;
      seenThread.add(threadId);
      const lastActivityAt = Number(meta.lastActivityAt || meta.internalDate || 0) || 0;
      rawRows.push({
        id: `email:gmail:${threadId}`,
        threadId,
        gmailId: String(meta.lastMessageId || '').trim(),
        subject: String(meta.subject || '').trim(),
        to: String(meta.to || '').trim(),
        toName: recipientListLabel(meta.to),
        snippet: String(meta.snippet || '').trim(),
        status: 'sent',
        provider: 'gmail',
        sentAt: lastActivityAt,
        lastActivityAt,
        messageCount: Number(meta.messageCount) || 1,
        beaconId: '',
        attached: false,
        attachMeta: [],
        _gmailListIdx: rawRows.length,
      });
    }

    // Gmail threads.list order ≠ newest-message time (harden orphans / query match).
    // Sort this page by each thread's newest message timestamp, then re-rank.
    const ordered = [...rawRows].sort((a, b) => {
      const db = Number(b.lastActivityAt) || 0;
      const da = Number(a.lastActivityAt) || 0;
      if (db !== da) return db - da;
      return (Number(a._gmailListIdx) || 0) - (Number(b._gmailListIdx) || 0);
    }).map((row, rank) => {
      const { _gmailListIdx, ...rest } = row;
      return { ...rest, sentRank: rank };
    });

    return {
      ok: true,
      source: 'gmail-threads-page-v1',
      upserted: ordered.length,
      nextPageToken: listed.nextPageToken || '',
      resultSizeEstimate: listed.resultSizeEstimate || ordered.length,
      emails: ordered,
    };
  },

  /* —— legacy list helpers (disabled for outreach restart; kept for other callers) —— */
  // 'emails.ensureFromBeacons': … see git history / unused by new Sent sync path

  /**
   * @deprecated Outreach list no longer uses per-row meta refresh for chronology.
   */
  'emails.refreshThreadMeta': async (p = {}) => {
    // Kept as no-op-ish best-effort snippet bump only — does NOT change list order/subjects.
    const rows = await email.get();
    const ids = Array.isArray(p?.threadIds) && p.threadIds.length
      ? p.threadIds.map((t) => String(t || '').trim()).filter(Boolean)
      : rows.map((r) => String(r.threadId || '').trim()).filter(Boolean);
    if (!ids.length) return { ok: true, updated: 0, threads: [] };
    const metas = await getGmailThreadsMetaBatch(ids);
    const byId = new Map(metas.map((m) => [m.id, m]));
    const updated = [];
    for (const row of rows) {
      const tid = String(row.threadId || '').trim();
      if (!tid) continue;
      const meta = byId.get(tid);
      if (!meta) continue;
      const lastActivityAt = meta.lastActivityAt || meta.internalDate || row.lastActivityAt || row.sentAt || 0;
      await email.post({
        id: row.id,
        snippet: meta.snippet || row.snippet,
        gmailId: meta.lastMessageId || row.gmailId,
        lastActivityAt,
      });
      updated.push({ id: row.id, threadId: tid, lastActivityAt });
    }
    return { ok: true, updated: updated.length, threads: updated };
  },
  /** Fetch a Sent message from Gmail for the Outreach reading pane. */
  'email.getGmail': async (p) => {
    const out = await getGmailMessage(p?.gmailId || p?.id);
    return out;
  },
  /** Fetch a full Gmail thread (conversation) for the Outreach reader. */
  'email.getThread': (p) => getGmailThread(p?.threadId || p?.id),
  /** Full chat for one Gmail threadId only. */
  'email.getConversation': (p) => getGmailConversation({
    threadId: p?.threadId || p?.id,
  }),
  'email.trashThread': async (p) => {
    const threadId = String(p?.threadId || p?.id || '').trim();
    return trashGmailThread(threadId);
  },
  'email.getThreadsBatch': (p) => getGmailThreadsFullBatch(p?.threadIds || p?.ids || []),
  'email.getThreadMeta': (p) => getGmailThreadMeta(p?.threadId || p?.id),
  'email.getThreadsMetaBatch': (p) => getGmailThreadsMetaBatch(p?.threadIds || p?.ids || []),
  /** Download one Gmail attachment (base64url). */
  'email.getAttachment': (p) => getGmailAttachment({
    messageId: p?.messageId || p?.gmailId,
    attachmentId: p?.attachmentId,
  }),
  /** Open a Gmail thread (reply/forward happens in Gmail UI). */
  'email.openInGmail': async (p) => {
    const threadId = String(p?.threadId || p?.gmailId || '').trim();
    if (!threadId) throw new Error('threadId required');
    const url = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
    const tabs = await chrome.tabs.query({ url: ['https://mail.google.com/*'] });
    const existing = (tabs || []).find((t) => t.id != null);
    if (existing?.id != null) {
      await chrome.tabs.update(existing.id, { url, active: true });
      if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url, active: true });
    }
    return { ok: true, url };
  },
  /** Upsert outreach/webmail tracking log. Dedupes by id / beaconId / threadId. */
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
    const explicitId = (p.id && String(p.id).startsWith('email:')) ? p.id : '';
    if (explicitId) {
      return email.post({
        ...p,
        id: explicitId,
        to: to || p.to,
        subject: subject || p.subject,
        beaconId: beaconId || p.beaconId,
        jobsimp,
        lastActivityAt: p.lastActivityAt ?? p.sentAt ?? Date.now(),
      });
    }
    if (beaconId) {
      const existing = await email.findByBeacon(beaconId);
      if (existing) {
        return email.post({
          id: existing.id,
          to: to || existing.to,
          subject: subject || existing.subject,
          beaconId,
          gmailId: p.gmailId ?? existing.gmailId,
          threadId: p.threadId ?? existing.threadId,
          snippet: p.snippet ?? existing.snippet,
          attached: p.attached ?? existing.attached,
          attachMeta: p.attachMeta ?? existing.attachMeta,
          body: '',
          status: p.status || existing.status || 'sent',
          provider: p.provider || existing.provider || '',
          sentAt: p.sentAt ?? existing.sentAt ?? Date.now(),
          lastActivityAt: p.lastActivityAt ?? p.sentAt ?? Date.now(),
          jobsimp,
        });
      }
    }
    const threadId = String(p.threadId || '').trim();
    if (threadId) {
      const byThread = await email.findByThreadId(threadId);
      if (byThread) {
        return email.post({
          id: byThread.id,
          to: to || byThread.to,
          subject: subject || byThread.subject,
          beaconId: beaconId || byThread.beaconId,
          gmailId: p.gmailId ?? byThread.gmailId,
          threadId,
          snippet: p.snippet ?? byThread.snippet,
          attached: p.attached ?? byThread.attached,
          attachMeta: p.attachMeta ?? byThread.attachMeta,
          body: '',
          status: p.status || byThread.status || 'sent',
          provider: p.provider || byThread.provider || '',
          sentAt: p.sentAt ?? byThread.sentAt ?? Date.now(),
          lastActivityAt: p.lastActivityAt ?? p.sentAt ?? Date.now(),
          jobsimp: jobsimp || byThread.jobsimp,
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
      lastActivityAt: p.lastActivityAt ?? p.sentAt ?? Date.now(),
    });
  },
  'beacon.ensure': (p) => ensureBeacon({ id: p?.id, meta: p?.meta }),
  'beacon.register': (p) => registerBeacon({ id: p?.id, meta: p?.meta }),
  'beacon.create': (p) => createPixel(p),
  'beacon.list': (p) => listPixels({ from: p?.from || p?.meta?.from }),
  'beacon.reset': (p) => resetBeacon(p?.id),
  'beacon.track': (p) => trackBeacon(p?.id),
  'beacon.pixelHtml': (p) => ({
    html: pixelHtml(p?.id, { defer: !!p?.defer }),
    id: p?.id || '',
  }),
  'beacon.allocId': (p) => ({ id: allocBeaconId(p?.id) }),
  'beacon.extractId': (p) => extractBeaconId(p?.html || p?.body || ''),
  /**
   * Native Gmail send handoff: enqueue durable harden→register (no early Cloud Run create).
   * Optional gmailMessageIdHint from data-legacy-last-*-message-id.
   */
  'beacon.hardenSent': (p) => finalizeNativeSend({
    beaconId: p?.beaconId,
    to: p?.to,
    from: p?.from,
    subject: p?.subject,
    source: p?.source || 'gmail/google',
    sentAt: p?.sentAt,
    gmailMessageIdHint: p?.gmailMessageId || p?.gmailMessageIdHint,
  }),
  /** Schedule send: bake pixel in UI; watch until Sent, then same harden→register. */
  'beacon.watchScheduled': (p) => watchScheduledSend({
    beaconId: p?.beaconId,
    to: p?.to,
    meta: p?.meta,
  }),
  'email.drainTxs': () => drainEmailTxs(),
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
  'open.outreach.compose': async (p) => {
    const q = new URLSearchParams({ tab: 'outreach' });
    if (p?.jobId) q.set('jobId', String(p.jobId));
    if (p?.resumeId) q.set('resumeId', String(p.resumeId));
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/component/dashboard/dashboard.html?${q}`) });
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
  'field.resolve': (p) => resolveOneField(p),
  'field.rewrite': (p) => rewriteField(p),
  'application.advance': (p) => advanceApplication(p),
  'application.userAnswer': (p) => saveUserAnswer(p),
  'application.complete': async (p, sender) => {
    if (sender?.tab?.id) applyCtxByTab.delete(sender.tab.id);
    return completeApplication(p);
  },
  'application.abandon': (_p, sender) => {
    if (sender?.tab?.id) applyCtxByTab.delete(sender.tab.id);
    return { ok: true };
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
    if (p.channel === 'linkedin') {
      const surface = p.surface || (p.mode === 'invite' ? 'invite' : 'message');
      // Pass identity always; draft-email gates inclusion (outreach / career demand).
      // JD only when user picked a job in the ⋮ menu.
      const wantJd = !!p.jobId;
      const out = await draftLinkedInMessage(s, {
        surface,
        userNote: p.userNote || p.context || '',
        chatHistory: p.chatHistory || '',
        peerBlurb: p.peerBlurb || '',
        maxChars: p.maxChars || 0,
        attachResume: !!p.attachResume,
        company: wantJd ? (p.company || jobRow?.company || '') : '',
        role: wantJd ? (p.role || jobRow?.role || '') : '',
        recipients,
        identity,
        jdGraph: wantJd ? jdGraph : null,
      });
      if (out?.via !== 'llm') throw new Error('Draft path did not use LLM — reload the extension.');
      return out;
    }

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

  'email.send': async (p) => sendTrackedEmail(p, {
    buildResumeAttachment,
    getSettings,
    getUserEmail: async () => (await getUser())?.email || '',
  }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) { sendResponse({ ok: false, error: `Unknown message: ${msg?.type}` }); return false; }
  Promise.resolve(h(msg.payload, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
