import { JOB_STATUSES, ACTIVE_STATUSES, EMPLOYMENT_TYPES, TRISTATE, REFERRAL } from '../../static/enums.js';
import { initProfilePanel, loadProfilePanel } from './profile.js';
import { initResumePanel, loadResumePanel } from './resume.js';
import { initSettingsPanel, loadSettingsPanel } from './settings.js';

const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fillOptions = (id, values) => { $(id).innerHTML = values.map((v) => `<option>${v}</option>`).join(''); };
let jobs = [], emails = [], editId = null;

const ACCOUNT_TABS = new Set(['profile', 'resume', 'settings']);
const MAIN_TABS = new Set(['tracker', 'outreach']);

export function activateTab(tab) {
  if (!tab || (!MAIN_TABS.has(tab) && !ACCOUNT_TABS.has(tab))) tab = 'tracker';

  document.querySelectorAll('.tab,.panel').forEach((e) => e.classList.remove('active'));
  document.querySelectorAll('#userDd button').forEach((b) => b.classList.remove('active'));

  if (MAIN_TABS.has(tab)) {
    document.querySelector(`.tab[data-tab="${tab}"]`)?.classList.add('active');
  } else {
    document.querySelector(`#userDd button[data-account="${tab}"]`)?.classList.add('active');
  }
  $(tab)?.classList.add('active');

  const url = new URL(location.href);
  if (tab === 'tracker') url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  history.replaceState(null, '', url.pathname + url.search);

  if (tab === 'profile') loadProfilePanel();
  if (tab === 'resume') loadResumePanel();
  if (tab === 'settings') loadSettingsPanel();
}

function closeUserMenu() {
  $('userDd').classList.remove('open');
  $('userBtn').classList.remove('open');
  $('userBtn').setAttribute('aria-expanded', 'false');
}

function initNav() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      closeUserMenu();
      activateTab(t.dataset.tab);
    };
  });

  $('userBtn').onclick = (e) => {
    e.stopPropagation();
    const open = !$('userDd').classList.contains('open');
    $('userDd').classList.toggle('open', open);
    $('userBtn').classList.toggle('open', open);
    $('userBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  $('userDd').onclick = (e) => {
    const b = e.target.closest('button[data-account]');
    if (!b) return;
    closeUserMenu();
    activateTab(b.dataset.account);
  };

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-menu')) closeUserMenu();
  });
}

async function loadUserButton() {
  const auth = await send('auth.get');
  const user = auth?.data;
  const label = user?.name || user?.email || 'Account';
  $('userLabel').textContent = label;
  const img = $('userAvatar');
  if (user?.picture) {
    img.src = user.picture;
    img.hidden = false;
  } else {
    img.hidden = true;
  }
}

$('fStatus').insertAdjacentHTML('beforeend', JOB_STATUSES.map((s) => `<option>${s}</option>`).join(''));
fillOptions('m_status', JOB_STATUSES);
fillOptions('m_type', EMPLOYMENT_TYPES);
fillOptions('m_sponsorship', TRISTATE);
fillOptions('m_everify', TRISTATE);
fillOptions('m_referral', REFERRAL);

async function loadAll() {
  const [j, e] = await Promise.all([send('job.list'), send('emails.list')]);
  jobs = j?.data || []; emails = e?.data || [];
  renderTracker(); renderOutreach();
}

function yn(v) { return v === 'Yes' ? '<span class="yes">Yes</span>' : v === 'No' ? '<span class="no">No</span>' : '<span class="unk">?</span>'; }

function renderTracker() {
  const q = $('q').value.toLowerCase(), fs = $('fStatus').value;
  const today = new Date().toISOString().slice(0, 10);
  const list = jobs
    .filter((j) => (!q || `${j.company} ${j.role}`.toLowerCase().includes(q)) && (!fs || j.status === fs))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  $('jobRows').innerHTML = list.map((j) => `<tr>
    <td>${esc(j.date)}</td>
    <td><strong>${esc(j.company) || '<span class="unk">—</span>'}</strong>${j.url ? ` <a href="${esc(j.url)}" target="_blank" style="color:var(--accent)">↗</a>` : ''}</td>
    <td>${esc(j.role)}</td>
    <td>${j.type && j.type !== 'Unknown' ? `<span class="badge">${esc(j.type)}</span>` : '<span class="unk">—</span>'}</td>
    <td><span class="badge">${esc(j.status)}</span></td>
    <td>${yn(j.sponsorship)}</td><td>${yn(j.everify)}</td>
    <td>${esc(j.location) || '<span class="unk">—</span>'}</td>
    <td>${esc(j.salary) || '<span class="unk">—</span>'}</td>
    <td>${j.followup ? (j.followup <= today ? `<span style="color:var(--yellow);font-weight:600">⚠ ${j.followup}</span>` : j.followup) : ''}</td>
    <td>${j.referral === 'Yes' ? '✓' : ''}</td>
    <td><button class="small" data-edit="${j.id}">✎</button> <button class="small" data-email="${j.id}">✉</button> <button class="small" data-del="${j.id}">✕</button></td>
  </tr>`).join('') || '<tr><td colspan="12" style="color:var(--muted)">No jobs tracked yet.</td></tr>';

  const active = ACTIVE_STATUSES;
  const replied = jobs.filter((j) => [...active, 'Offer', 'Rejected'].includes(j.status)).length;
  $('stats').innerHTML = [
    ['Total', jobs.length], ['Active', jobs.filter((j) => active.includes(j.status)).length],
    ['Offers', jobs.filter((j) => j.status === 'Offer').length],
    ['Sponsor ✓', jobs.filter((j) => j.sponsorship === 'Yes').length],
    ['Response rate', jobs.length ? Math.round((replied / jobs.length) * 100) + '%' : '–'],
  ].map(([l, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
}
$('q').oninput = renderTracker; $('fStatus').onchange = renderTracker;

$('jobRows').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.edit) openModal(b.dataset.edit);
  if (b.dataset.del && confirm('Delete this job?')) { await send('job.delete', { id: b.dataset.del }); loadAll(); }
  if (b.dataset.email) {
    activateTab('outreach');
    $('c_job').value = b.dataset.email;
  }
};

$('addJob').onclick = () => openModal(null);
$('cancelBtn').onclick = () => $('modal').classList.remove('open');
$('modal').onclick = (e) => { if (e.target.id === 'modal') $('modal').classList.remove('open'); };

function openModal(id) {
  editId = id;
  const j = id ? jobs.find((x) => x.id === id) || {} : {};
  $('modalTitle').textContent = id ? 'Edit Job' : 'Add Job';
  $('m_company').value = j.company || ''; $('m_role').value = j.role || '';
  $('m_type').value = j.type || EMPLOYMENT_TYPES[0];
  $('m_date').value = j.date || new Date().toISOString().slice(0, 10);
  $('m_datePosted').value = j.datePosted || '';
  $('m_status').value = j.status || JOB_STATUSES[0];
  $('m_sponsorship').value = j.sponsorship || TRISTATE[0]; $('m_everify').value = j.everify || TRISTATE[0];
  $('m_followup').value = j.followup || ''; $('m_referral').value = j.referral || REFERRAL[0];
  $('m_location').value = j.location || ''; $('m_salary').value = j.salary || '';
  $('m_url').value = j.url || ''; $('m_jd').value = j.jdText || ''; $('m_notes').value = j.notes || '';
  $('modal').classList.add('open');
}

$('saveBtn').onclick = async () => {
  if (!$('m_company').value.trim() || !$('m_role').value.trim()) return alert('Company and Role required');
  const payload = {
    company: $('m_company').value.trim(), role: $('m_role').value.trim(), type: $('m_type').value,
    date: $('m_date').value, datePosted: $('m_datePosted').value,
    status: $('m_status').value, sponsorship: $('m_sponsorship').value, everify: $('m_everify').value,
    followup: $('m_followup').value, referral: $('m_referral').value, location: $('m_location').value,
    salary: $('m_salary').value, url: $('m_url').value, jdText: $('m_jd').value, notes: $('m_notes').value,
  };
  if (editId) { payload.id = editId; payload.createdAt = jobs.find((x) => x.id === editId)?.createdAt; }
  await send('job.save', payload);
  $('modal').classList.remove('open'); loadAll();
};

function renderOutreach() {
  $('c_job').innerHTML = '<option value="">— no linked job —</option>' +
    jobs.map((j) => `<option value="${j.id}">${esc(j.company)} — ${esc(j.role)}</option>`).join('');
  $('emailRows').innerHTML = emails.sort((a, b) => b.createdAt - a.createdAt).map((m) => {
    const j = jobs.find((x) => x.id === m.jobId);
    return `<tr><td>${m.sentAt ? new Date(m.sentAt).toISOString().slice(0, 10) : ''}</td>
      <td>${esc(m.to)}</td><td>${esc(m.subject)}</td>
      <td>${j ? esc(j.company) : ''}</td>
      <td>${m.status === 'sent' ? '<span class="yes">sent</span>' : m.status === 'failed' ? `<span class="no">failed</span> <span class="unk">${esc(m.error || '')}</span>` : m.status}</td></tr>`;
  }).join('') || '<tr><td colspan="5" style="color:var(--muted)">No emails yet.</td></tr>';
}

$('draftBtn').onclick = async () => {
  const jobId = $('c_job').value || null;
  const j = jobs.find((x) => x.id === jobId);
  const jdText = $('c_jd').value.trim() || j?.jdText || '';
  if (!jdText) return $('draftStatus').textContent = 'Pick a job with JD text or paste a JD.';
  $('draftStatus').textContent = 'Drafting…';
  const res = await send('ai.draft', { jdText, company: j?.company || '', role: j?.role || '' });
  if (res?.ok) {
    $('c_subject').value = res.data.subject; $('c_body').value = res.data.body;
    $('draftStatus').textContent = `Drafted with ${res.data.provider}. Review before sending.`;
    $('c_body').dataset.provider = res.data.provider;
  } else $('draftStatus').textContent = `Draft failed: ${res?.error}`;
};

$('sendBtn').onclick = async () => {
  const recipients = $('c_to').value;
  if (!recipients.trim()) return $('sendres').textContent = 'Add at least one recipient.';
  if (!$('c_subject').value || !$('c_body').value) return $('sendres').textContent = 'Subject and body required (use Draft with AI or write manually).';
  if (!confirm(`Send to: ${recipients}?`)) return;
  $('sendres').textContent = 'Sending…';
  const res = await send('email.send', {
    jobId: $('c_job').value || null,
    recipients, subject: $('c_subject').value, body: $('c_body').value,
    provider: $('c_body').dataset.provider || '',
  });
  $('sendres').textContent = res?.ok
    ? res.data.map((r) => `${r.to}: ${r.status}${r.error ? ` (${r.error})` : ''}`).join('\n')
    : `Send failed: ${res?.error}`;
  loadAll();
};

initNav();
initProfilePanel();
initResumePanel();
initSettingsPanel();
loadUserButton();
loadAll();

const initialTab = new URLSearchParams(location.search).get('tab');
if (initialTab) activateTab(initialTab);
