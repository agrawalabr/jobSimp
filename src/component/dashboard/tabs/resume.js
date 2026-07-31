// Resume tab: upload / paste, parse via LLM, edit the parsed graph.
import { $, send, data, esc, flash } from '../lib/dom.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let editResumeId = null;
let editSkills = [];

// ---------- list ----------

function renderCard(r) {
  const skills = r.parsed?.skills || [];
  const id = esc(r.id);
  return `
    <div class="rz">
      <div class="rz-main">
        <div class="rz-title">${esc(r.name)}${r.isDefault ? '<span class="badge ok">default</span>' : ''}</div>
        <div class="rz-meta">${r.parsed
    ? `parsed · ${skills.length} skills · ${(r.parsed.experiences || []).length} roles`
    : '<span class="badge pending">not parsed</span>'}</div>
        ${r.parsed && skills.length
    ? `<div class="chips">${skills.slice(0, 12).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}${
      skills.length > 12 ? `<span class="chip">+${skills.length - 12}</span>` : ''}</div>`
    : ''}
      </div>
      <div class="rz-actions">
        ${r.parsed
    ? `<button class="small" data-edit="${id}">Edit</button><button class="small" data-parse="${id}">Re-parse</button>`
    : `<button class="small" data-parse="${id}">Parse</button>`}
        ${!r.isDefault ? `<button class="small" data-default="${id}">Set default</button>` : ''}
        <button class="small" data-del="${id}">Delete</button>
      </div>
    </div>`;
}

async function refreshResumes() {
  const list = await data('resumes.list', undefined, []);
  $('resumeListLabel').textContent = list.length ? `Your resumes (${list.length})` : 'Your resumes';
  $('resumeList').innerHTML = list.length
    ? list.map(renderCard).join('')
    : '<div class="hint">No resumes yet — upload a PDF/txt or paste text above.</div>';
}

// ---------- upload ----------

/** Chunked so a multi-MB PDF can't blow the argument limit of String.fromCharCode. */
function bytesToB64(buf) {
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function saveFiles(fileList) {
  $('resumeErr').textContent = '';
  const errors = [];

  for (const f of fileList) {
    try {
      const isDocx = f.type === DOCX_MIME || /\.docx$/i.test(f.name);
      const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      let payload;

      if (isPdf || isDocx) {
        payload = {
          name: f.name.replace(/\.(pdf|docx)$/i, ''),
          mime: isDocx ? DOCX_MIME : 'application/pdf',
          dataB64: bytesToB64(new Uint8Array(await f.arrayBuffer())),
          text: '',
        };
      } else if (f.type === 'text/plain' || /\.txt$/i.test(f.name)) {
        payload = {
          name: f.name.replace(/\.txt$/i, ''),
          mime: 'text/plain',
          dataB64: '',
          text: await f.text(),
        };
      } else {
        errors.push(`${f.name}: use PDF, .docx, or .txt`);
        continue;
      }

      const res = await send('resumes.save', payload);
      if (!res?.ok) errors.push(`${f.name}: ${res?.error || 'save failed'}`);
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }

  $('resumeErr').textContent = errors.join('\n');
  await refreshResumes();
}

// ---------- parsed-data editor ----------

function renderSkillTags() {
  $('ed_skills').innerHTML = editSkills
    .map((s, i) => `<span class="skill-tag">${esc(s)}<span class="remove-skill" data-ski="${i}" role="button" aria-label="Remove ${esc(s)}">&times;</span></span>`)
    .join('');
}

function showEditPanel(resumeName, parsed, resumeId) {
  editResumeId = resumeId;
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
  $('ed_json').value = JSON.stringify(parsed, null, 2);
  renderSkillTags();
  $('ed_err').textContent = '';
  $('editPanel').style.display = 'block';
  $('editPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideEditPanel() {
  $('editPanel').style.display = 'none';
  editResumeId = null;
  editSkills = [];
}

/** The JSON box is the source of truth; the friendly fields override its scalars. */
function collectEdits() {
  let fromJson;
  try {
    fromJson = JSON.parse($('ed_json').value);
  } catch (e) {
    throw new Error(`Parsed JSON is invalid: ${e.message}`);
  }
  if (!fromJson || typeof fromJson !== 'object' || Array.isArray(fromJson)) {
    throw new Error('Parsed JSON must be an object.');
  }
  return {
    ...fromJson,
    name: $('ed_name').value,
    email: $('ed_email').value,
    phone: $('ed_phone').value,
    address: $('ed_address').value,
    links: {
      ...(fromJson.links || {}),
      linkedin: $('ed_linkedin').value,
      github: $('ed_github').value,
      portfolio: $('ed_portfolio').value,
    },
    summary: $('ed_summary').value,
    skills: [...editSkills],
  };
}

async function onListClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  $('resumeErr').textContent = '';

  if (b.dataset.parse) {
    const label = b.textContent;
    b.textContent = '…';
    b.disabled = true;
    const res = await send('resumes.parse', { id: b.dataset.parse });
    if (!res?.ok) {
      b.textContent = label;
      b.disabled = false;
      $('resumeErr').textContent = `Parse failed: ${res?.error || 'unknown'}`;
      await refreshResumes();
      return;
    }
    const r = await data('resumes.get', { id: b.dataset.parse }, null);
    showEditPanel(r?.name || '', res.data, b.dataset.parse);
    await refreshResumes();
    return;
  }

  if (b.dataset.edit) {
    const r = await data('resumes.get', { id: b.dataset.edit }, null);
    if (!r?.parsed) { $('resumeErr').textContent = 'This resume has not been parsed yet.'; return; }
    showEditPanel(r.name, r.parsed, r.id);
    return;
  }

  if (b.dataset.default) await send('resumes.setDefault', { id: b.dataset.default });

  if (b.dataset.del) {
    if (!confirm('Delete this resume?')) return;
    await send('resumes.delete', { id: b.dataset.del });
    if (editResumeId === b.dataset.del) hideEditPanel();
  }

  await refreshResumes();
}

export async function mount() {
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

  $('resumeFile').onchange = async (e) => {
    await saveFiles(e.target.files);
    e.target.value = '';
  };

  $('pasteBtn').onclick = () => {
    const box = $('pasteArea');
    box.style.display = box.style.display === 'block' ? 'none' : 'block';
  };

  $('pasteSave').onclick = async () => {
    const text = $('pasteText').value.trim();
    if (!text) { $('resumeErr').textContent = 'Paste some resume text first.'; return; }
    const res = await send('resumes.save', {
      name: $('pasteName').value.trim() || 'Pasted resume',
      mime: 'text/plain',
      dataB64: '',
      text: $('pasteText').value,
    });
    if (!res?.ok) { $('resumeErr').textContent = `Save failed: ${res?.error}`; return; }
    $('pasteText').value = '';
    $('pasteName').value = '';
    $('pasteArea').style.display = 'none';
    await refreshResumes();
  };

  $('ed_skills').onclick = (e) => {
    const rm = e.target.closest('.remove-skill');
    if (!rm) return;
    editSkills.splice(Number(rm.dataset.ski), 1);
    renderSkillTags();
  };

  $('ed_addSkillBtn').onclick = () => {
    const v = $('ed_newSkill').value.trim();
    if (!v || editSkills.includes(v)) { $('ed_newSkill').value = ''; return; }
    editSkills.push(v);
    $('ed_newSkill').value = '';
    renderSkillTags();
  };
  $('ed_newSkill').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('ed_addSkillBtn').click(); }
  };

  $('ed_save').onclick = async () => {
    $('ed_err').textContent = '';
    try {
      const parsed = collectEdits();
      const res = await send('resumes.saveParsed', { id: editResumeId, parsed, parsedAt: Date.now() });
      if (!res?.ok) throw new Error(res?.error || 'Save failed');
      hideEditPanel();
      flash('resumeMsg', 'Saved');
      await refreshResumes();
    } catch (err) {
      $('ed_err').textContent = err.message;
    }
  };
  $('ed_cancel').onclick = hideEditPanel;

  $('resumeList').onclick = onListClick;

  await refreshResumes();
}
