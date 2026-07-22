import { modelsFor, defaultModelFor, findModel, optionLabel, consumptionHint,
  DEFAULT_PROVIDER, emptyKeys, providerOptionsHtml } from '../../static/models.js';
import { parseResume } from '../../service/resume.js';
import { DEV_LLM_KEYS } from '../../static/env.js';

// All IndexedDB / auth goes through the SW so there is a single dao cache
// (activeResumeId / graphMem). parseResume stays in-page (no dao; needs DOM for UX).
const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));
async function sw(type, payload) {
  const res = await send(type, payload);
  if (!res?.ok) throw new Error(res?.error || `${type} failed`);
  return res.data;
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- stepper ----
let step = 1;
function goto(n) {
  step = n;
  for (let i = 1; i <= 3; i++) {
    const panel = $(`p${i}`);
    const chip = $(`s${i}`);
    panel.style.display = i === n ? 'block' : 'none';
    chip.classList.toggle('active', i === n);
    chip.classList.toggle('done', i < n);
    chip.classList.toggle('upcoming', i > n);
  }
  if (n === 2) loadAIStep();
  if (n === 3) refreshResumes();
}

// ---- step 1: auth ----
async function refreshAuth() {
  const u = await sw('auth.get');
  $('signedOut').style.display = u ? 'none' : 'block';
  $('signedIn').style.display = u ? 'flex' : 'none';
  $('next1').disabled = !u;
  $('next1Wrap').classList.toggle('is-disabled', !u);
  if (u) { $('u_pic').src = u.picture || ''; $('u_name').textContent = u.name; $('u_email').textContent = u.email; }
}

$('signinBtn').onclick = async () => {
  $('err1').textContent = '';
  try {
    await sw('auth.signin');
  } catch (err) {
    const redirect = chrome.identity.getRedirectURL();
    $('err1').textContent =
      `Sign-in failed: ${err.message}\n\n` +
      `OAuth uses HTTPS redirect:\n${redirect}\n\n` +
      `In Google Cloud → Credentials → Web application client:\n` +
      `• Authorized redirect URIs → add the URL above\n` +
      `• Paste that client ID into manifest.json oauth2.client_id`;
  }
  refreshAuth();
};

$('signoutBtn').onclick = async () => { await sw('auth.signout'); refreshAuth(); };
$('next1').onclick = () => goto(2);

// ---- step 2: AI key ----
// Provider <select> is driven by static/models.js PROVIDERS.
$('ai_provider').innerHTML = providerOptionsHtml(DEFAULT_PROVIDER);

// Dev fallback — used only when dao secrets have no key for a provider (remove before release).
let llmKeys = emptyKeys();

function mergeLlmKeys(stored = {}) {
  const keys = { ...emptyKeys(), ...DEV_LLM_KEYS };
  for (const [p, v] of Object.entries(stored)) {
    if (String(v || '').trim()) keys[p] = v.trim();
  }
  return keys;
}

function fillModels(provider, selected) {
  const list = modelsFor(provider);
  const pick = selected && list.some((m) => m.id === selected) ? selected : defaultModelFor(provider);
  $('ai_model').innerHTML = list.map((m) =>
    `<option value="${m.id}" ${m.id === pick ? 'selected' : ''}>${optionLabel(m)}</option>`).join('');
  $('modelHint').textContent = consumptionHint(findModel(provider, pick));
}

function showKeyForProvider(provider) {
  $('ai_key').value = llmKeys[provider] || '';
  syncNext2();
}

function syncNext2() {
  const ok = !!$('ai_key').value.trim();
  $('next2').disabled = !ok;
  $('next2Wrap').classList.toggle('is-disabled', !ok);
}

function getAISettings() {
  const provider = $('ai_provider').value || DEFAULT_PROVIDER;
  return {
    provider,
    model: $('ai_model').value || defaultModelFor(provider),
    key: $('ai_key').value.trim() || llmKeys[provider] || '',
  };
}

async function loadAIStep() {
  const d = await sw('defaults.get');
  llmKeys = mergeLlmKeys(d.llm.keys);
  const provider = d.llm.provider || DEFAULT_PROVIDER;
  $('ai_provider').value = provider;
  fillModels(provider, d.llm.model);
  showKeyForProvider(provider);
}

$('ai_provider').onchange = () => { fillModels($('ai_provider').value); showKeyForProvider($('ai_provider').value); };
$('ai_model').onchange = () => { $('modelHint').textContent = consumptionHint(findModel($('ai_provider').value, $('ai_model').value)); };
$('ai_key').oninput = () => { llmKeys[$('ai_provider').value] = $('ai_key').value.trim(); syncNext2(); };
$('back2').onclick = () => goto(1);
$('next2').onclick = async () => {
  const key = $('ai_key').value.trim();
  if (!key) return;
  const provider = $('ai_provider').value;
  llmKeys[provider] = key;
  await sw('defaults.update', { llm: { provider, model: $('ai_model').value, keys: { [provider]: key } } });
  goto(3);
};

// ---- step 3: resumes ----
function renderResumeCard(r) {
  return `
    <div class="rz">
      <div class="rz-main">
        <div class="rz-title">${esc(r.name)} ${r.isDefault ? '<span class="badge">default</span>' : ''}</div>
        <div class="rz-meta">${r.parsed ? `✓ parsed · ${r.parsed.skills.length} skills · ${r.parsed.experiences.length} roles` : '<span class="badge pending">not parsed</span>'}</div>
        ${r.parsed ? `<div class="chips">${r.parsed.skills.slice(0, 12).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}${r.parsed.skills.length > 12 ? `<span class="chip">+${r.parsed.skills.length - 12}</span>` : ''}</div>
        <details><summary>Parsed data</summary><pre>${esc(JSON.stringify(r.parsed, null, 2))}</pre></details>` : ''}
      </div>
      <div class="rz-actions">
        ${!r.parsed ? `<button class="small" data-parse="${r.id}">✨ Parse</button>` : `<button class="small" data-parse="${r.id}">↻ Re-parse</button>`}
        ${!r.isDefault ? `<button class="small" data-default="${r.id}">Set default</button>` : ''}
        <button class="small" data-del="${r.id}">✕ Delete</button>
      </div>
    </div>`;
}

async function refreshResumes() {
  const list = await sw('resumes.list');
  $('resumeListLabel').textContent = list.length ? `Your resumes (${list.length})` : 'Your resumes';
  $('resumeList').innerHTML = list.length
    ? list.map(renderResumeCard).join('')
    : '<div class="hint">No resumes yet — upload a PDF/txt or paste text above.</div>';
  syncFinish(list);
}

function syncFinish(list = []) {
  const ok = list.some((r) => r.isDefault && r.parsed);
  $('finish').disabled = !ok;
  $('finishWrap').classList.toggle('is-disabled', !ok);
}

async function saveFiles(fileList) {
  $('err3').textContent = '';
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  for (const f of fileList) {
    try {
      const isBinary = f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
        || f.type === DOCX_MIME || /\.docx$/i.test(f.name);
      if (isBinary) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = ''; buf.forEach((b) => { bin += String.fromCharCode(b); });
        const mime = /\.docx$/i.test(f.name) || f.type === DOCX_MIME ? DOCX_MIME : 'application/pdf';
        const name = f.name.replace(/\.(pdf|docx)$/i, '');
        await sw('resumes.save', { name, mime, dataB64: btoa(bin), text: '' });
      } else if (f.type === 'text/plain' || /\.txt$/i.test(f.name)) {
        await sw('resumes.save', { name: f.name.replace(/\.txt$/i, ''), mime: 'text/plain', dataB64: '', text: await f.text() });
      } else {
        $('err3').textContent = `${f.name}: use PDF, .docx, or .txt`;
      }
    } catch (err) { $('err3').textContent = `${f.name}: ${err.message}`; }
  }
  refreshResumes();
}

const dropZone = $('dropZone');
['dragenter', 'dragover'].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drag'); });
});
['dragleave', 'drop'].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('drag'); });
});
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) saveFiles(e.dataTransfer.files);
});

$('file').onchange = async (e) => {
  await saveFiles(e.target.files);
  e.target.value = '';
};

$('pasteBtn').onclick = () => {
  const box = $('pasteArea');
  box.style.display = box.style.display === 'block' ? 'none' : 'block';
};
$('pasteSave').onclick = async () => {
  if (!$('pasteText').value.trim()) return;
  await sw('resumes.save', { name: $('pasteName').value.trim() || 'Pasted resume', mime: 'text/plain', dataB64: '', text: $('pasteText').value });
  $('pasteText').value = ''; $('pasteName').value = ''; $('pasteArea').style.display = 'none';
  refreshResumes();
};

// ---- editable parse flow ----
let editResumeId = null, editParsed = null, editSkills = [];

function showEditPanel(resumeName, parsed, resumeId) {
  editResumeId = resumeId;
  editParsed = parsed;
  editSkills = [...(parsed.skills || [])];

  $('editResumeName').textContent = `— ${resumeName}`;
  $('ed_name').value = parsed.name || '';
  $('ed_email').value = parsed.email || '';
  $('ed_phone').value = parsed.phone || '';
  $('ed_address').value = parsed.address || '';
  $('ed_linkedin').value = parsed.links?.linkedin || '';
  $('ed_github').value = parsed.links?.github || '';
  $('ed_portfolio').value = parsed.links?.portfolio || '';
  $('ed_summary').value = parsed.summary || '';

  renderSkillTags();
  renderEntries('ed_experiences', parsed.experiences || [], renderExpEntry);
  renderEntries('ed_projects', parsed.projects || [], renderProjEntry);
  renderEntries('ed_education', parsed.education || [], renderEduEntry);
  renderEntries('ed_certificates', parsed.certificates || [], renderCertEntry);

  $('editPanel').style.display = 'block';
  $('editPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideEditPanel() {
  $('editPanel').style.display = 'none';
  editResumeId = null;
  editParsed = null;
  editSkills = [];
}

// -- Skills tag editor --
function renderSkillTags() {
  $('ed_skills').innerHTML = editSkills.map((s, i) =>
    `<span class="skill-tag">${esc(s)}<span class="remove-skill" data-ski="${i}">&times;</span></span>`
  ).join('');
}

$('ed_skills').onclick = (e) => {
  const rm = e.target.closest('.remove-skill');
  if (!rm) return;
  editSkills.splice(Number(rm.dataset.ski), 1);
  renderSkillTags();
};

$('ed_addSkillBtn').onclick = () => {
  const v = $('ed_newSkill').value.trim();
  if (!v) return;
  editSkills.push(v);
  $('ed_newSkill').value = '';
  renderSkillTags();
};

$('ed_newSkill').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('ed_addSkillBtn').click(); }
};

// -- Entry renderers --
function renderEntries(containerId, items, renderFn) {
  const c = $(containerId);
  c.innerHTML = '';
  items.forEach((item, i) => { c.insertAdjacentHTML('beforeend', renderFn(item, i)); });
}

function renderExpEntry(e, i) {
  return `<div class="entry-card" data-idx="${i}">
    <button class="remove-entry" type="button" data-remove="exp" data-ri="${i}">&times;</button>
    <div class="edit-grid">
      <div class="edit-field"><label>Company</label><input data-f="exp.company" data-i="${i}" value="${esc(e.company)}"></div>
      <div class="edit-field"><label>Role</label><input data-f="exp.role" data-i="${i}" value="${esc(e.role)}"></div>
      <div class="edit-field"><label>Location</label><input data-f="exp.location" data-i="${i}" value="${esc(e.location)}"></div>
      <div class="edit-field"><label>Start</label><input data-f="exp.start" data-i="${i}" value="${esc(e.start)}"></div>
      <div class="edit-field"><label>End</label><input data-f="exp.end" data-i="${i}" value="${esc(e.end)}"></div>
    </div>
    <div class="edit-grid full" style="margin-top:8px">
      <div class="edit-field"><label>Description</label><textarea data-f="exp.description" data-i="${i}" rows="4">${esc(e.description)}</textarea></div>
    </div>
  </div>`;
}

function renderProjEntry(p, i) {
  return `<div class="entry-card" data-idx="${i}">
    <button class="remove-entry" type="button" data-remove="proj" data-ri="${i}">&times;</button>
    <div class="edit-grid">
      <div class="edit-field"><label>Name</label><input data-f="proj.name" data-i="${i}" value="${esc(p.name)}"></div>
      <div class="edit-field"><label>URL</label><input data-f="proj.url" data-i="${i}" value="${esc(p.url)}"></div>
    </div>
    <div class="edit-grid full" style="margin-top:8px">
      <div class="edit-field"><label>Description</label><textarea data-f="proj.description" data-i="${i}" rows="4">${esc(p.description)}</textarea></div>
    </div>
  </div>`;
}

function renderEduEntry(e, i) {
  return `<div class="entry-card" data-idx="${i}">
    <button class="remove-entry" type="button" data-remove="edu" data-ri="${i}">&times;</button>
    <div class="edit-grid">
      <div class="edit-field"><label>School</label><input data-f="edu.school" data-i="${i}" value="${esc(e.school)}"></div>
      <div class="edit-field"><label>Degree</label><input data-f="edu.degree" data-i="${i}" value="${esc(e.degree)}"></div>
      <div class="edit-field"><label>Program</label><input data-f="edu.program" data-i="${i}" value="${esc(e.program)}"></div>
      <div class="edit-field"><label>Location</label><input data-f="edu.location" data-i="${i}" value="${esc(e.location)}"></div>
      <div class="edit-field"><label>Start</label><input data-f="edu.start" data-i="${i}" value="${esc(e.start)}"></div>
      <div class="edit-field"><label>End</label><input data-f="edu.end" data-i="${i}" value="${esc(e.end)}"></div>
      <div class="edit-field"><label>GPA</label><input data-f="edu.gpa" data-i="${i}" value="${esc(e.gpa)}"></div>
      <div class="edit-field"><label>Out of</label><input data-f="edu.outof" data-i="${i}" value="${esc(e.outof)}"></div>
    </div>
  </div>`;
}

function renderCertEntry(c, i) {
  return `<div class="entry-card" data-idx="${i}">
    <button class="remove-entry" type="button" data-remove="cert" data-ri="${i}">&times;</button>
    <div class="edit-grid">
      <div class="edit-field"><label>Name</label><input data-f="cert.name" data-i="${i}" value="${esc(c.name)}"></div>
      <div class="edit-field"><label>Issuer</label><input data-f="cert.issuer" data-i="${i}" value="${esc(c.issuer)}"></div>
      <div class="edit-field"><label>Issue date</label><input data-f="cert.issueDate" data-i="${i}" value="${esc(c.issueDate)}"></div>
      <div class="edit-field"><label>Expiration</label><input data-f="cert.expirationDate" data-i="${i}" value="${esc(c.expirationDate)}"></div>
      <div class="edit-field"><label>URL</label><input data-f="cert.url" data-i="${i}" value="${esc(c.url)}"></div>
    </div>
  </div>`;
}

// -- Remove entries --
for (const id of ['ed_experiences', 'ed_projects', 'ed_education', 'ed_certificates']) {
  $(id).onclick = (e) => {
    const btn = e.target.closest('.remove-entry');
    if (!btn) return;
    btn.closest('.entry-card').remove();
  };
}

// -- Add empty entries --
$('ed_addExp').onclick = () => {
  $('ed_experiences').insertAdjacentHTML('beforeend', renderExpEntry(
    { company: '', role: '', location: '', start: '', end: '', description: '' },
    $('ed_experiences').children.length));
};
$('ed_addProj').onclick = () => {
  $('ed_projects').insertAdjacentHTML('beforeend', renderProjEntry(
    { name: '', description: '', url: '' },
    $('ed_projects').children.length));
};
$('ed_addEdu').onclick = () => {
  $('ed_education').insertAdjacentHTML('beforeend', renderEduEntry(
    { school: '', degree: '', program: '', location: '', start: '', end: '', gpa: '', outof: '' },
    $('ed_education').children.length));
};
$('ed_addCert').onclick = () => {
  $('ed_certificates').insertAdjacentHTML('beforeend', renderCertEntry(
    { name: '', issuer: '', issueDate: '', expirationDate: '', url: '' },
    $('ed_certificates').children.length));
};

// -- Collect edits back into a structured object --
function collectEntries(containerId, prefix, fields) {
  const cards = $(containerId).querySelectorAll('.entry-card');
  return [...cards].map((card) => {
    const obj = {};
    for (const f of fields) {
      const el = card.querySelector(`[data-f="${prefix}.${f}"]`);
      obj[f] = el ? el.value : '';
    }
    return obj;
  });
}

function collectEdits() {
  return {
    name: $('ed_name').value,
    email: $('ed_email').value,
    phone: $('ed_phone').value,
    address: $('ed_address').value,
    links: {
      linkedin: $('ed_linkedin').value,
      github: $('ed_github').value,
      portfolio: $('ed_portfolio').value,
      other: editParsed?.links?.other || {},
    },
    summary: $('ed_summary').value,
    skills: [...editSkills],
    experiences: collectEntries('ed_experiences', 'exp', ['company', 'role', 'location', 'start', 'end', 'description']),
    projects: collectEntries('ed_projects', 'proj', ['name', 'description', 'url']),
    education: collectEntries('ed_education', 'edu', ['school', 'degree', 'program', 'location', 'start', 'end', 'gpa', 'outof']),
    certificates: collectEntries('ed_certificates', 'cert', ['name', 'issuer', 'issueDate', 'expirationDate', 'url']),
  };
}

// -- Save edited resume --
$('ed_save').onclick = async () => {
  $('ed_err').textContent = '';
  const parsed = collectEdits();
  try {
    await sw('resumes.saveParsed', { id: editResumeId, parsed, parsedAt: Date.now() });
    hideEditPanel();
    refreshResumes();
  } catch (err) {
    $('ed_err').textContent = err.message;
  }
};

$('ed_cancel').onclick = () => hideEditPanel();

// -- Parse click: LLM in-page (edit before persist), then save via SW --
$('resumeList').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (!b.dataset.parse && !b.dataset.default && !b.dataset.del) return;
  $('err3').textContent = '';

  if (b.dataset.parse) {
    const ai = getAISettings();
    if (!ai.key) {
      $('err3').textContent = 'No API key found. Go back to Step 2 and enter your key.';
      return;
    }

    b.textContent = '…parsing'; b.disabled = true;

    try {
      const resumeId = b.dataset.parse;
      const r = await sw('resumes.get', { id: resumeId });
      if (!r) throw new Error('Resume not found');

      const doc = { text: r.text || '', dataB64: r.dataB64 || '', mime: r.mime || 'text/plain' };
      const parsed = await parseResume(doc, ai.model, ai.key, ai.provider);

      showEditPanel(r.name, parsed, r.id);
    } catch (err) {
      $('err3').textContent = `Parse failed: ${err.message}`;
      b.textContent = '✨ Parse'; b.disabled = false;
    }
    return;
  }

  if (b.dataset.default) await sw('resumes.setDefault', { id: b.dataset.default });
  if (b.dataset.del && confirm('Delete this resume?')) await sw('resumes.delete', { id: b.dataset.del });
  refreshResumes();
};

$('back3').onclick = () => goto(2);
$('finish').onclick = async () => {
  const list = await sw('resumes.list');
  if (!list.some((r) => r.isDefault && r.parsed)) return;
  await sw('onboarding.complete');
  location.href = chrome.runtime.getURL('src/component/dashboard/dashboard.html');
};

loadAIStep();
refreshAuth();
refreshResumes();
