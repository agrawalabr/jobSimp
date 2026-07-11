// JobSimp service worker: message router + job polling + notifications.
import * as db from '../lib/db.js';
import { draftEmail } from '../lib/ai.js';
import { sendEmail, parseRecipients } from '../lib/gmail.js';
import { fetchGreenhouse, fetchLever, fetchSimplify } from '../lib/sources.js';
import { scoreJob, dedupeKey } from '../lib/scoring.js';
import { getSettings, saveSettings } from '../lib/settings.js';

const ALARM = 'jobsimp-poll';
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAABuUlEQVR42u3du1EDMRCAYUmQuDp3QEruQpyT0oGrc8SYDnj4dI/d/b4GgNv/VvIMA60BAAAAVfStv+D5en947D+7XU49TQAGfuwgusHXDqEbfO0QhuHHM/M5d4OvvQ2G4dfeBsPwa0cwDL92BMPwa0cwPLbahre/9hYYhl87AkeAI8DbX3kL2AA2gLe/8hawAWwABIAAnP817wE2gA2AABAAAkAACAABIAAEgABI7zXbD/Tx9rX613j/fLEBEAACQAC4BB7dkkvbFpdKGwABIAAEgAAQAD4GTpX9o5wNgAAQABHvABHP59nf856/X2ADOAIQAAJAAAgAASAABIAAEAACQAAIAAEgAASAABAAAkAACAABIAAEgAAQAAJAAAgAASAAjm/3PxCR6Z8v2AAIAAEgAASAABAAAkAACAABEDGA2+XUPaa4fpufDWADIAAE4B5Q7/y3Afh7ALZAvrffBuB/AdgCud7+pzaACPIM3xHAcwHYAjne/kUbQATxh7/4CBBB7OFPuQOIIO7wW2tt6vDO1/vDSGIMfpVPAbZBrOFP3wC2QZzBrx6AEGJs1s1XtiAcpQAAAOzmGwB8gtjgnSq7AAAAAElFTkSuQmCC';

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  chrome.alarms.create(ALARM, { periodInMinutes: s.polling.intervalHours * 60, delayInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) pollJobs().catch(console.error); });

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html#feed') });
});

// ---------- polling ----------
async function pollJobs() {
  const s = await getSettings();
  const profile = await db.getProfile();
  const keywords = profile.keywords || [];
  const batches = [];

  for (const t of s.polling.targets) {
    try {
      if (t.ats === 'greenhouse') batches.push(await fetchGreenhouse(t.slug, t.company));
      else if (t.ats === 'lever') batches.push(await fetchLever(t.slug, t.company));
    } catch (e) { console.warn('poll target failed', t, e.message); }
  }
  if (s.polling.simplifyFeed) {
    try { batches.push(await fetchSimplify()); } catch (e) { console.warn('simplify failed', e.message); }
  }

  const fresh = [];
  for (const job of batches.flat()) {
    const key = dedupeKey(job.source, job.externalId);
    if (await db.getDiscovered(key)) continue;
    const score = scoreJob(job, keywords);
    if (score < s.polling.minScore) {
      await db.upsertDiscovered({ key, ...job, score, seenAt: Date.now(), state: 'dismissed' });
      continue;
    }
    await db.upsertDiscovered({ key, ...job, score, seenAt: Date.now(), state: 'new' });
    fresh.push({ ...job, score });
  }

  if (fresh.length) {
    fresh.sort((a, b) => b.score - a.score);
    const top = fresh.slice(0, 3).map((j) => `${j.company}: ${j.title}`).join('\n');
    chrome.notifications.create('jobsimp-new-jobs', {
      type: 'basic',
      iconUrl: ICON,
      title: `JobSimp: ${fresh.length} new relevant job${fresh.length > 1 ? 's' : ''}`,
      message: top,
      priority: 2,
    });
    for (const j of fresh) {
      await db.upsertDiscovered({ ...(await db.getDiscovered(dedupeKey(j.source, j.externalId))), state: 'notified' });
    }
  }
  return fresh.length;
}

// ---------- message router ----------
const handlers = {
  'job.save': (p) => db.saveJob(p),
  'job.list': () => db.listJobs(),
  'job.delete': (p) => db.deleteJob(p.id),
  'profile.get': () => db.getProfile(),
  'profile.set': (p) => db.setProfile(p.key, p.value),
  'answers.list': () => db.listAnswers(),
  'answers.save': (p) => db.saveAnswer(p),
  'answers.delete': (p) => db.deleteAnswer(p.id),
  'emails.list': () => db.listEmails(),
  'discovered.list': () => db.listDiscovered(),
  'discovered.update': (p) => db.upsertDiscovered(p),
  'settings.get': () => getSettings(),
  'settings.save': async (p) => {
    await saveSettings(p);
    chrome.alarms.create(ALARM, { periodInMinutes: (p.polling?.intervalHours || 6) * 60 });
    return true;
  },
  'poll.now': () => pollJobs(),

  'ai.draft': async (p) => {
    const s = await getSettings();
    const profile = await db.getProfile();
    return draftEmail(s, { ...p, resumeText: profile.resumeText || '' });
  },

  'email.send': async (p) => {
    // p: {jobId, recipients: "a@x.com, b@y.com", subject, body, personalize}
    const s = await getSettings();
    const list = parseRecipients(p.recipients);
    if (!list.length) throw new Error('No valid email addresses found.');
    const results = [];
    for (const to of list) {
      const rec = { jobId: p.jobId ?? null, to, subject: p.subject, body: p.body, provider: p.provider || '', status: 'draft' };
      try {
        const gmailId = await sendEmail({ to, subject: p.subject, body: p.body, fromName: s.gmail.fromName });
        rec.status = 'sent'; rec.gmailId = gmailId; rec.sentAt = Date.now();
      } catch (e) {
        rec.status = 'failed'; rec.error = e.message;
      }
      await db.saveEmail(rec);
      results.push({ to, status: rec.status, error: rec.error });
    }
    return results;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) { sendResponse({ ok: false, error: `Unknown message: ${msg?.type}` }); return false; }
  Promise.resolve(h(msg.payload))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // async
});
