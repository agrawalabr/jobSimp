// Tracker tab: the applications table + the add/edit modal.
import {
  JOB_STATUSES, ACTIVE_STATUSES, EMPLOYMENT_TYPES, TRISTATE, REFERRAL,
} from '../../../static/enums.js';
import { $, send, data, esc, fillOptions } from '../lib/dom.js';

let jobs = [];
let editId = null;

const yn = (v) => (v === 'Yes'
  ? '<span class="yes">Yes</span>'
  : v === 'No' ? '<span class="no">No</span>' : '<span class="unk">?</span>');

function renderStats() {
  const replied = jobs.filter((j) => [...ACTIVE_STATUSES, 'Offer', 'Rejected'].includes(j.status)).length;
  $('stats').innerHTML = [
    ['Total', jobs.length],
    ['Active', jobs.filter((j) => ACTIVE_STATUSES.includes(j.status)).length],
    ['Offers', jobs.filter((j) => j.status === 'Offer').length],
    ['Sponsor ✓', jobs.filter((j) => j.sponsorship === 'Yes').length],
    ['Response rate', jobs.length ? `${Math.round((replied / jobs.length) * 100)}%` : '–'],
  ].map(([l, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
}

function render() {
  const q = $('q').value.trim().toLowerCase();
  const fs = $('fStatus').value;
  const today = new Date().toISOString().slice(0, 10);

  const list = jobs
    .filter((j) => (!q || `${j.company} ${j.role}`.toLowerCase().includes(q)) && (!fs || j.status === fs))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  $('jobRows').innerHTML = list.map((j) => `<tr>
    <td>${esc(j.date)}</td>
    <td><strong>${esc(j.company) || '<span class="unk">—</span>'}</strong>${
  j.url ? ` <a href="${esc(j.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">↗</a>` : ''}</td>
    <td>${esc(j.role)}</td>
    <td>${j.type && j.type !== 'Unknown' ? `<span class="badge">${esc(j.type)}</span>` : '<span class="unk">—</span>'}</td>
    <td><span class="badge">${esc(j.status)}</span></td>
    <td>${yn(j.sponsorship)}</td><td>${yn(j.everify)}</td>
    <td>${esc(j.location) || '<span class="unk">—</span>'}</td>
    <td>${esc(j.salary) || '<span class="unk">—</span>'}</td>
    <td>${j.followup
    ? (j.followup <= today ? `<span style="color:var(--yellow);font-weight:600">⚠ ${esc(j.followup)}</span>` : esc(j.followup))
    : ''}</td>
    <td>${j.referral === 'Yes' ? '✓' : ''}</td>
    <td>
      <button class="small" data-edit="${esc(j.id)}" title="Edit">✎</button>
      <button class="small" data-email="${esc(j.id)}" title="Draft outreach">✉</button>
      <button class="small" data-del="${esc(j.id)}" title="Delete">✕</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="12" style="color:var(--muted)">No jobs tracked yet.</td></tr>';

  renderStats();
}

async function reload() {
  jobs = await data('job.list', undefined, []);
  render();
}

function openModal(id) {
  editId = id;
  const j = (id && jobs.find((x) => x.id === id)) || {};
  $('modalTitle').textContent = id ? 'Edit Job' : 'Add Job';
  $('m_err').textContent = '';
  $('m_company').value = j.company || '';
  $('m_role').value = j.role || '';
  $('m_type').value = j.type || EMPLOYMENT_TYPES[0];
  $('m_date').value = j.date || new Date().toISOString().slice(0, 10);
  $('m_datePosted').value = j.datePosted || '';
  $('m_status').value = j.status || JOB_STATUSES[0];
  $('m_sponsorship').value = j.sponsorship || TRISTATE[0];
  $('m_everify').value = j.everify || TRISTATE[0];
  $('m_followup').value = j.followup || '';
  $('m_referral').value = j.referral || REFERRAL[0];
  $('m_location').value = j.location || '';
  $('m_salary').value = j.salary || '';
  $('m_url').value = j.url || '';
  $('m_jd').value = j.jdText || '';
  $('m_notes').value = j.notes || '';
  $('modal').classList.add('open');
  $('m_company').focus();
}

const closeModal = () => $('modal').classList.remove('open');

async function saveJob() {
  const company = $('m_company').value.trim();
  const role = $('m_role').value.trim();
  if (!company || !role) {
    $('m_err').textContent = 'Company and Role are required.';
    return;
  }

  const payload = {
    company,
    role,
    type: $('m_type').value,
    date: $('m_date').value,
    datePosted: $('m_datePosted').value,
    status: $('m_status').value,
    sponsorship: $('m_sponsorship').value,
    everify: $('m_everify').value,
    followup: $('m_followup').value,
    referral: $('m_referral').value,
    location: $('m_location').value,
    salary: $('m_salary').value,
    url: $('m_url').value.trim(),
    jdText: $('m_jd').value,
    notes: $('m_notes').value,
  };
  if (editId) {
    payload.id = editId;
    payload.createdAt = jobs.find((x) => x.id === editId)?.createdAt;
  }

  const res = await send('job.save', payload);
  if (!res?.ok) {
    $('m_err').textContent = `Save failed: ${res?.error || 'unknown error'}`;
    return;
  }
  closeModal();
  reload();
}

export async function mount() {
  $('fStatus').insertAdjacentHTML('beforeend', JOB_STATUSES.map((s) => `<option>${esc(s)}</option>`).join(''));
  fillOptions('m_status', JOB_STATUSES);
  fillOptions('m_type', EMPLOYMENT_TYPES);
  fillOptions('m_sponsorship', TRISTATE);
  fillOptions('m_everify', TRISTATE);
  fillOptions('m_referral', REFERRAL);

  $('q').oninput = render;
  $('fStatus').onchange = render;
  $('addJob').onclick = () => openModal(null);
  $('cancelBtn').onclick = closeModal;
  $('saveBtn').onclick = saveJob;
  $('modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
  document.addEventListener('keydown', onKeydown);

  $('jobRows').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.edit) return openModal(b.dataset.edit);
    if (b.dataset.del) {
      if (!confirm('Delete this job?')) return;
      await send('job.delete', { id: b.dataset.del });
      return reload();
    }
    if (b.dataset.email) {
      // Hand off to the outreach tab with this job preselected.
      window.dispatchEvent(new CustomEvent('jobsimp:navigate', {
        detail: { tab: 'outreach', params: { jobId: b.dataset.email } },
      }));
    }
    return undefined;
  };

  await reload();
}

function onKeydown(e) {
  if (e.key === 'Escape' && $('modal')?.classList.contains('open')) closeModal();
}

export function unmount() {
  document.removeEventListener('keydown', onKeydown);
}
