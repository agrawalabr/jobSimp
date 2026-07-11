const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let settings = null, answers = [], targets = [];

const BASIC_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'linkedin', 'github', 'city', 'state',
  'university', 'degree', 'major', 'gradDate', 'workAuth', 'needsSponsorship'];

async function load() {
  const [sRes, pRes, aRes] = await Promise.all([send('settings.get'), send('profile.get'), send('answers.list')]);
  settings = sRes.data; answers = aRes.data || [];
  const profile = pRes.data || {};

  $('ai_provider').value = settings.ai.provider;
  $('ai_model').value = settings.ai.model || '';
  $('key_gemini').value = settings.ai.keys.gemini || '';
  $('key_claude').value = settings.ai.keys.claude || '';
  $('key_openai').value = settings.ai.keys.openai || '';
  $('gmail_fromName').value = settings.gmail.fromName || '';
  $('tmpl_tone').value = settings.emailTemplate.tone || '';
  $('tmpl_signature').value = settings.emailTemplate.signature || '';
  $('poll_interval').value = settings.polling.intervalHours;
  $('poll_minScore').value = settings.polling.minScore;
  $('poll_simplify').checked = !!settings.polling.simplifyFeed;
  targets = settings.polling.targets || [];

  $('resumeText').value = profile.resumeText || '';
  $('keywords').value = (profile.keywords || []).join(', ');
  const basics = profile.basics || {};
  BASIC_FIELDS.forEach((f) => { if ($(`b_${f}`)) $(`b_${f}`).value = basics[f] || ''; });

  renderQA(); renderTargets();
}

function renderQA() {
  $('qa_rows').innerHTML = answers.map((a) => `<tr>
    <td>${esc(a.question)}</td><td>${esc((a.patterns || []).join(', '))}</td>
    <td>${esc(a.answer).slice(0, 80)}</td>
    <td><button class="small" data-del="${a.id}">✕</button></td></tr>`).join('');
}
function renderTargets() {
  $('t_rows').innerHTML = targets.map((t, i) => `<tr>
    <td>${esc(t.company)}</td><td>${esc(t.ats)}</td><td>${esc(t.slug)}</td>
    <td><button class="small" data-tdel="${i}">✕</button></td></tr>`).join('');
}

$('qa_add').onclick = async () => {
  const question = $('qa_question').value.trim(), answer = $('qa_answer').value.trim();
  if (!question || !answer) return;
  const patterns = $('qa_patterns').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  await send('answers.save', { question, answer, patterns: patterns.length ? patterns : [question.toLowerCase()], type: 'text', useCount: 0 });
  $('qa_question').value = $('qa_patterns').value = $('qa_answer').value = '';
  answers = (await send('answers.list')).data; renderQA();
};
$('qa_rows').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b?.dataset.del) return;
  await send('answers.delete', { id: Number(b.dataset.del) });
  answers = (await send('answers.list')).data; renderQA();
};

$('t_add').onclick = () => {
  const company = $('t_company').value.trim(), slug = $('t_slug').value.trim().toLowerCase();
  if (!company || !slug) return;
  targets.push({ company, ats: $('t_ats').value, slug });
  $('t_company').value = $('t_slug').value = '';
  renderTargets();
};
$('t_rows').onclick = (e) => {
  const b = e.target.closest('button'); if (!b?.dataset.tdel) return;
  targets.splice(Number(b.dataset.tdel), 1); renderTargets();
};

$('saveAll').onclick = async () => {
  const newSettings = {
    ai: {
      provider: $('ai_provider').value, model: $('ai_model').value.trim(),
      keys: { gemini: $('key_gemini').value.trim(), claude: $('key_claude').value.trim(), openai: $('key_openai').value.trim() },
    },
    gmail: { enabled: true, fromName: $('gmail_fromName').value.trim() },
    polling: {
      intervalHours: Math.max(1, Number($('poll_interval').value) || 6),
      minScore: Math.min(100, Math.max(0, Number($('poll_minScore').value) || 40)),
      simplifyFeed: $('poll_simplify').checked, targets,
    },
    emailTemplate: { tone: $('tmpl_tone').value.trim(), signature: $('tmpl_signature').value },
  };
  const basics = {};
  BASIC_FIELDS.forEach((f) => { basics[f] = $(`b_${f}`)?.value.trim() || ''; });
  const keywords = $('keywords').value.split(',').map((s) => s.trim()).filter(Boolean);

  await Promise.all([
    send('settings.save', newSettings),
    send('profile.set', { key: 'resumeText', value: $('resumeText').value }),
    send('profile.set', { key: 'basics', value: basics }),
    send('profile.set', { key: 'keywords', value: keywords }),
  ]);
  $('saveMsg').textContent = '✓ Saved';
  setTimeout(() => { $('saveMsg').textContent = ''; }, 2500);
};

load();
