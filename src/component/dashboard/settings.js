import {
  modelsFor, defaultModelFor, findModel, optionLabel, consumptionHint,
  PROVIDERS, providerIds, providerOptionsHtml,
} from '../../static/models.js';

const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let answers = [];

function fillModels(provider, selected) {
  const list = modelsFor(provider);
  const pick = selected && list.some((m) => m.id === selected) ? selected : defaultModelFor(provider);
  $('ai_model').innerHTML = list.map((m) =>
    `<option value="${m.id}" ${m.id === pick ? 'selected' : ''}>${optionLabel(m)}</option>`).join('');
  $('modelHint').textContent = consumptionHint(findModel(provider, pick));
}

function renderQA() {
  $('qa_rows').innerHTML = answers.map((a) => `<tr>
    <td>${esc(a.question)}</td><td>${esc((a.patterns || []).join(', '))}</td>
    <td>${esc(a.answer).slice(0, 80)}</td>
    <td><button class="small" data-del="${a.id}">✕</button></td></tr>`).join('');
}

export async function loadSettingsPanel() {
  const [sRes, aRes] = await Promise.all([send('settings.get'), send('answers.list')]);
  const settings = sRes?.data;
  answers = aRes?.data || [];
  if (!settings) return;

  $('ai_provider').value = settings.ai.provider;
  fillModels(settings.ai.provider, settings.ai.model || '');
  providerIds().forEach((id) => {
    const el = $(`key_${id}`);
    if (el) el.value = settings.ai.keys[id] || '';
  });
  $('gmail_fromName').value = settings.gmail.fromName || '';
  $('tmpl_tone').value = settings.emailTemplate.tone || '';
  $('tmpl_signature').value = settings.emailTemplate.signature || '';
  renderQA();
}

export function initSettingsPanel() {
  $('ai_provider').innerHTML = providerOptionsHtml();
  $('keyFields').innerHTML = PROVIDERS.map((p) =>
    `<div class="field"><label>${p.keyLabel}</label><input type="password" id="key_${p.id}"></div>`).join('');

  $('ai_provider').onchange = () => fillModels($('ai_provider').value);
  $('ai_model').onchange = () => {
    $('modelHint').textContent = consumptionHint(findModel($('ai_provider').value, $('ai_model').value));
  };

  $('qa_add').onclick = async () => {
    const question = $('qa_question').value.trim();
    const answer = $('qa_answer').value.trim();
    if (!question || !answer) return;
    const patterns = $('qa_patterns').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    await send('answers.save', {
      question,
      answer,
      patterns: patterns.length ? patterns : [question.toLowerCase()],
      type: 'text',
      useCount: 0,
    });
    $('qa_question').value = $('qa_patterns').value = $('qa_answer').value = '';
    answers = (await send('answers.list')).data || [];
    renderQA();
  };

  $('qa_rows').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b?.dataset.del) return;
    await send('answers.delete', { id: b.dataset.del });
    answers = (await send('answers.list')).data || [];
    renderQA();
  };

  $('saveAll').onclick = async () => {
    const newSettings = {
      ai: {
        provider: $('ai_provider').value,
        model: $('ai_model').value,
        keys: Object.fromEntries(providerIds().map((id) => [id, $(`key_${id}`).value.trim()])),
      },
      gmail: { enabled: true, fromName: $('gmail_fromName').value.trim() },
      emailTemplate: { tone: $('tmpl_tone').value.trim(), signature: $('tmpl_signature').value },
    };
    await send('settings.save', newSettings);
    $('saveMsg').textContent = 'Saved';
    setTimeout(() => { $('saveMsg').textContent = ''; }, 2500);
  };
}
