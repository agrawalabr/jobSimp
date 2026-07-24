const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let editResumeId = null;
let editParsed = null;
let editSkills = [];
let activeResumeId = null;

function renderResumeCard(r) {
  const skills = r.parsed?.skills || [];
  return `
    <div class="rz">
      <div class="rz-main">
        <div class="rz-title">${esc(r.name)}
          ${r.isDefault ? '<span class="badge ok">default</span>' : ''}
        </div>
        <div class="rz-meta">${r.parsed
    ? `parsed · ${skills.length} skills · ${(r.parsed.experiences || []).length} roles`
    : '<span class="badge pending">not parsed</span>'}</div>
        ${r.parsed && skills.length
    ? `<div class="chips">${skills.slice(0, 12).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}${skills.length > 12 ? `<span class="chip">+${skills.length - 12}</span>` : ''}</div>`
    : ''}
      </div>
      <div class="rz-actions">
        ${r.parsed
    ? `<button class="small" data-edit="${r.id}">Edit</button><button class="small" data-parse="${r.id}">Re-parse</button>`
    : `<button class="small" data-parse="${r.id}">Parse</button>`}
        ${!r.isDefault ? `<button class="small" data-default="${r.id}">Set default</button>` : ''}
        <button class="small" data-del="${r.id}">Delete</button>
      </div>
    </div>`;
}

async function refreshResumes() {
  const listRes = await send('resumes.list');
  const list = listRes?.data || [];
  activeResumeId = list.find((r) => r.isDefault)?.id || list[0]?.id || null;
  $('resumeListLabel').textContent = list.length ? `Your resumes (${list.length})` : 'Your resumes';
  $('resumeList').innerHTML = list.length
    ? list.map(renderResumeCard).join('')
    : '<div class="hint">No resumes yet — upload a PDF/txt or paste text above.</div>';
}

async function saveFiles(fileList) {
  $('resumeErr').textContent = '';
  for (const f of fileList) {
    try {
      const isBinary = f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
        || f.type === DOCX_MIME || /\.docx$/i.test(f.name);
      if (isBinary) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        buf.forEach((b) => { bin += String.fromCharCode(b); });
        const mime = /\.docx$/i.test(f.name) || f.type === DOCX_MIME ? DOCX_MIME : 'application/pdf';
        const name = f.name.replace(/\.(pdf|docx)$/i, '');
        await send('resumes.save', { name, mime, dataB64: btoa(bin), text: '' });
      } else if (f.type === 'text/plain' || /\.txt$/i.test(f.name)) {
        await send('resumes.save', { name: f.name.replace(/\.txt$/i, ''), mime: 'text/plain', dataB64: '', text: await f.text() });
      } else {
        $('resumeErr').textContent = `${f.name}: use PDF, .docx, or .txt`;
      }
    } catch (err) {
      $('resumeErr').textContent = `${f.name}: ${err.message}`;
    }
  }
  await refreshResumes();
}

function renderSkillTags() {
  $('ed_skills').innerHTML = editSkills.map((s, i) =>
    `<span class="skill-tag">${esc(s)}<span class="remove-skill" data-ski="${i}">&times;</span></span>`).join('');
}

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
  $('ed_json').value = JSON.stringify(parsed, null, 2);
  renderSkillTags();
  $('ed_err').textContent = '';
  $('editPanel').style.display = 'block';
  $('editPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideEditPanel() {
  $('editPanel').style.display = 'none';
  editResumeId = null;
  editParsed = null;
  editSkills = [];
}

function collectEdits() {
  let fromJson = null;
  try {
    fromJson = JSON.parse($('ed_json').value);
  } catch {
    throw new Error('Parsed JSON is invalid');
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

export async function loadResumePanel() {
  await refreshResumes();
}

export function initResumePanel() {
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
    if (!$('pasteText').value.trim()) return;
    await send('resumes.save', {
      name: $('pasteName').value.trim() || 'Pasted resume',
      mime: 'text/plain',
      dataB64: '',
      text: $('pasteText').value,
    });
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
    if (!v) return;
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
      $('resumeMsg').textContent = '';
      await refreshResumes();
    } catch (err) {
      $('ed_err').textContent = err.message;
    }
  };
  $('ed_cancel').onclick = () => hideEditPanel();

  $('resumeList').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('resumeErr').textContent = '';

    if (b.dataset.parse) {
      b.textContent = '…';
      b.disabled = true;
      const res = await send('resumes.parse', { id: b.dataset.parse });
      if (!res?.ok) {
        $('resumeErr').textContent = `Parse failed: ${res?.error || 'unknown'}`;
        await refreshResumes();
        return;
      }
      const r = (await send('resumes.get', { id: b.dataset.parse })).data;
      showEditPanel(r?.name || '', res.data, b.dataset.parse);
      await refreshResumes();
      return;
    }

    if (b.dataset.edit) {
      const r = (await send('resumes.get', { id: b.dataset.edit })).data;
      if (!r?.parsed) return;
      showEditPanel(r.name, r.parsed, r.id);
      return;
    }

    if (b.dataset.default) await send('resumes.setDefault', { id: b.dataset.default });
    if (b.dataset.del && confirm('Delete this resume?')) {
      await send('resumes.delete', { id: b.dataset.del });
      if (editResumeId === b.dataset.del) hideEditPanel();
    }
    await refreshResumes();
  };
}
