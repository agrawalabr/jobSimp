// JobSimp service worker: message router (Controller).
// Model: src/dao/<resource>.js classes (get/post/put/delete).

import { user, profile, metrics, settings, resume, job, answer, email, discovered } from '../dao/index.js';
import { draftEmail } from '../service/email.js';
import { parseResume } from '../service/resume.js';
import { sendEmail, parseRecipients } from '../service/gmail.js';
import { getSettings, saveSettings } from '../service/settings.js';
import { signIn, getUser, signOut } from '../service/oauth.js';
import { scoreJdAgainstResume, looksLikeJD } from '../service/match.js';
import { requestLLM, extractJson } from '../service/llm.js';
import { JD_ANALYSIS_PROMPT } from '../static/prompts.js';

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.alarms.clear('jobsimp-poll');
  chrome.alarms.clear('jobsimp-sync');
  const s = await settings.get();
  if (details.reason === 'install' || !s.onboarded) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/component/onboarding/onboarding.html') });
  }
});

chrome.alarms.clear('jobsimp-poll');
chrome.alarms.clear('jobsimp-sync');
resume.warm().catch((e) => console.warn('dao warm failed', e.message));

function removedStorage(name) {
  throw new Error(`${name} removed. Use src/dao/ (IndexedDB jobsimp-graph).`);
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
  'resumes.setDefault': async (p) => {
    await resume.setDefault(p.id);
    await resume.select(p.id);
    return true;
  },
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

  'jd.check': (p) => looksLikeJD(p.text),

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
  'match.score': async (p) => {
    if (p.resumeId) await resume.select(p.resumeId).catch(() => {});
    const r = await resume.active(p.resumeId || resume.activeId());
    if (!r?.parsed?.skills?.length) return null;
    if (p.generic && !looksLikeJD(p.jdText)) return null;
    return scoreJdAgainstResume(p.jdText, r.parsed.skills);
  },
  'autofill.here': async (_p, sender) => {
    const tabId = sender?.tab?.id;
    if (!tabId) throw new Error('No tab context');
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/autofill.js'] });
    return true;
  },

  'jd.analyze': async (p) => {
    const s = await getSettings();
    const { provider, model, keys } = s.ai || {};
    const key = keys?.[provider];
    if (!key) throw new Error(`No API key set for ${provider || 'your provider'}. Add one in Options.`);
    const r = await resume.active(p.resumeId || resume.activeId());
    if (!r?.parsed) throw new Error('Select a parsed resume first.');

    const parsed = r.parsed;
    const resumeLite = JSON.stringify({
      skills: parsed.skills || [],
      experiences: (parsed.experiences || []).map((e) => ({ role: e.role, company: e.company, description: String(e.description || '').slice(0, 400) })),
      projects: (parsed.projects || []).map((pr) => ({ name: pr.name, description: String(pr.description || '').slice(0, 300) })),
      education: parsed.education || [],
    });

    const meta = `URL: ${p.url || ''}\nSource: ${p.source || ''}\nAlready-detected fields: ${JSON.stringify(p.job || {})}`;
    const prompt = `${JD_ANALYSIS_PROMPT}\n\n=== JOB PAGE METADATA ===\n${meta}\n\n=== JOB DESCRIPTION ===\n${String(p.jdText || '').slice(0, 12000)}\n\n=== CANDIDATE RESUME (JSON) ===\n${resumeLite}`;

    const raw = await requestLLM({ provider, model, key, prompt, config: { temperature: 0, maxTokens: 1600 } });
    const out = extractJson(raw);
    if (!out) throw new Error('Model did not return parseable JSON.');
    return out;
  },

  'ai.draft': async (p) => {
    const s = await getSettings();
    const active = await resume.active(p.resumeId);
    let resumeText = active?.text || '';
    if (!resumeText && active?.parsed) resumeText = JSON.stringify(active.parsed);
    if (!resumeText) resumeText = (await profile.view()).resumeText || '';
    return draftEmail(s, { ...p, resumeText });
  },

  'email.send': async (p) => {
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
      await email.post(rec);
      results.push({ to, status: rec.status, error: rec.error });
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
