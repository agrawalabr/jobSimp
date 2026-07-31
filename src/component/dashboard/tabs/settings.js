// Settings tab: AI provider + keys, email defaults, Q&A bank.
import {
  modelsFor, defaultModelFor, findModel, optionLabel, consumptionHint,
  PROVIDERS, providerIds, providerOptionsHtml,
} from '../../../static/models.js';
import { $, send, data, esc, flash } from '../lib/dom.js';

let answers = [];

function fillModels(provider, selected) {
  const list = modelsFor(provider);
  const pick = selected && list.some((m) => m.id === selected) ? selected : defaultModelFor(provider);
  $('ai_model').innerHTML = list
    .map((m) => `<option value="${esc(m.id)}"${m.id === pick ? ' selected' : ''}>${esc(optionLabel(m))}</option>`)
    .join('');
  $('modelHint').textContent = consumptionHint(findModel(provider, pick));
}

function renderQA() {
  $('qa_rows').innerHTML = answers.map((a) => `<tr>
    <td>${esc(a.question)}</td>
    <td>${esc((a.patterns || []).join(', '))}</td>
    <td>${esc(String(a.answer || '').slice(0, 80))}</td>
    <td><button class="small" data-del="${esc(a.id)}" aria-label="Delete">✕</button></td>
  </tr>`).join('') || '<tr><td colspan="4" style="color:var(--muted)">No saved answers yet.</td></tr>';
}

async function refreshQA() {
  answers = await data('answers.list', undefined, []);
  renderQA();
}

async function load() {
  const [settings] = await Promise.all([data('settings.get', undefined, null), refreshQA()]);
  if (!settings) {
    flash('saveMsg', 'Could not load settings.', 5000);
    return;
  }

  $('ai_provider').value = settings.ai.provider;
  fillModels(settings.ai.provider, settings.ai.model || '');
  providerIds().forEach((id) => {
    const el = $(`key_${id}`);
    if (el) el.value = settings.ai.keys?.[id] || '';
  });
  $('gmail_fromName').value = settings.gmail?.fromName || '';
  $('tmpl_tone').value = settings.emailTemplate?.tone || '';
  $('tmpl_signature').value = settings.emailTemplate?.signature || '';
}

async function addAnswer() {
  const question = $('qa_question').value.trim();
  const answer = $('qa_answer').value.trim();
  if (!question || !answer) {
    flash('saveMsg', 'Question and answer are both required.');
    return;
  }
  const patterns = $('qa_patterns').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const res = await send('answers.save', {
    question,
    answer,
    patterns: patterns.length ? patterns : [question.toLowerCase()],
    type: 'text',
    useCount: 0,
  });
  if (!res?.ok) { flash('saveMsg', `Could not save: ${res?.error}`); return; }
  $('qa_question').value = '';
  $('qa_patterns').value = '';
  $('qa_answer').value = '';
  await refreshQA();
}

async function saveAll() {
  const btn = $('saveAll');
  btn.disabled = true;
  const res = await send('settings.save', {
    ai: {
      provider: $('ai_provider').value,
      model: $('ai_model').value,
      keys: Object.fromEntries(providerIds().map((id) => [id, $(`key_${id}`).value.trim()])),
    },
    gmail: { enabled: true, fromName: $('gmail_fromName').value.trim() },
    emailTemplate: { tone: $('tmpl_tone').value.trim(), signature: $('tmpl_signature').value },
  });
  btn.disabled = false;
  flash('saveMsg', res?.ok ? 'Saved' : `Save failed: ${res?.error}`);
}

export async function mount() {
  $('ai_provider').innerHTML = providerOptionsHtml();
  $('keyFields').innerHTML = PROVIDERS
    .map((p) => `<div class="field"><label>${esc(p.keyLabel)}</label><input type="password" id="key_${esc(p.id)}" autocomplete="off"></div>`)
    .join('');

  $('ai_provider').onchange = () => fillModels($('ai_provider').value);
  $('ai_model').onchange = () => {
    $('modelHint').textContent = consumptionHint(findModel($('ai_provider').value, $('ai_model').value));
  };

  $('qa_add').onclick = addAnswer;
  $('qa_rows').onclick = async (e) => {
    const b = e.target.closest('button[data-del]');
    if (!b) return;
    await send('answers.delete', { id: b.dataset.del });
    await refreshQA();
  };

  $('saveAll').onclick = saveAll;

  await load();
}
