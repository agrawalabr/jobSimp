const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATUSES = ['To Apply', 'Applied', 'OA', 'Phone Screen', 'Interview', 'Final Round', 'Offer', 'Rejected', 'Ghosted', 'Withdrawn'];
let jobs = [], discovered = [], emails = [], editId = null;

// tabs
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab,.panel').forEach((e) => e.classList.remove('active'));
    t.classList.add('active'); $(t.dataset.tab).classList.add('active');
  };
});
if (location.hash === '#feed') document.querySelector('[data-tab=feed]').click();

STATUSES.forEach((s) => {
  $('fStatus').insertAdjacentHTML('beforeend', `<option>${s}</option>`);
  $('m_status').insertAdjacentHTML('beforeend', `<option>${s}</option>`);
});

async function loadAll() {
  const [j, d, e] = await Promise.all([send('job.list'), send('discovered.list'), send('emails.list')]);
  jobs = j?.data || []; discovered = d?.data || []; emails = e?.data || [];
  renderTracker(); renderFeed(); renderOutreach();
}

// ---------- tracker ----------
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
    <td><span class="badge">${esc(j.status)}</span></td>
    <td>${yn(j.sponsorship)}</td><td>${yn(j.everify)}</td>
    <td>${j.followup ? (j.followup <= today ? `<span style="color:var(--yellow);font-weight:600">⚠ ${j.followup}</span>` : j.followup) : ''}</td>
    <td>${j.referral === 'Yes' ? '✓' : ''}</td>
    <td><button class="small" data-edit="${j.id}">✎</button> <button class="small" data-email="${j.id}">✉</button> <button class="small" data-del="${j.id}">✕</button></td>
  </tr>`).join('') || '<tr><td colspan="9" style="color:var(--muted)">No jobs tracked yet.</td></tr>';

  const active = ['OA', 'Phone Screen', 'Interview', 'Final Round'];
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
  if (b.dataset.edit) openModal(Number(b.dataset.edit));
  if (b.dataset.del && confirm('Delete this job?')) { await send('job.delete', { id: Number(b.dataset.del) }); loadAll(); }
  if (b.dataset.email) {
    document.querySelector('[data-tab=outreach]').click();
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
  $('m_date').value = j.date || new Date().toISOString().slice(0, 10);
  $('m_status').value = j.status || 'To Apply';
  $('m_sponsorship').value = j.sponsorship || 'Unknown'; $('m_everify').value = j.everify || 'Unknown';
  $('m_followup').value = j.followup || ''; $('m_referral').value = j.referral || 'No';
  $('m_location').value = j.location || ''; $('m_salary').value = j.salary || '';
  $('m_url').value = j.url || ''; $('m_jd').value = j.jdText || ''; $('m_notes').value = j.notes || '';
  $('modal').classList.add('open');
}

$('saveBtn').onclick = async () => {
  if (!$('m_company').value.trim() || !$('m_role').value.trim()) return alert('Company and Role required');
  const payload = {
    company: $('m_company').value.trim(), role: $('m_role').value.trim(), date: $('m_date').value,
    status: $('m_status').value, sponsorship: $('m_sponsorship').value, everify: $('m_everify').value,
    followup: $('m_followup').value, referral: $('m_referral').value, location: $('m_location').value,
    salary: $('m_salary').value, url: $('m_url').value, jdText: $('m_jd').value, notes: $('m_notes').value,
  };
  if (editId) { payload.id = editId; payload.createdAt = jobs.find((x) => x.id === editId)?.createdAt; }
  await send('job.save', payload);
  $('modal').classList.remove('open'); loadAll();
};

// ---------- feed ----------
function renderFeed() {
  const list = discovered.filter((d) => d.state !== 'dismissed' && d.state !== 'tracked').sort((a, b) => b.score - a.score);
  $('feedRows').innerHTML = list.map((d) => `<tr>
    <td class="score" style="color:${d.score >= 70 ? 'var(--green)' : d.score >= 40 ? 'var(--yellow)' : 'var(--muted)'}">${d.score}</td>
    <td>${esc(d.company)}</td>
    <td><a href="${esc(d.url)}" target="_blank" style="color:var(--accent)">${esc(d.title)}</a></td>
    <td>${esc(d.location)}</td>
    <td>${d.postedAt ? new Date(d.postedAt).toISOString().slice(0, 10) : ''}</td>
    <td><button class="small" data-track="${esc(d.key)}">➕ Track</button> <button class="small" data-dismiss="${esc(d.key)}">✕</button></td>
  </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">Nothing yet — add target companies in Settings, then Check now.</td></tr>';
}

$('feedRows').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = discovered.find((x) => x.key === (b.dataset.track || b.dataset.dismiss));
  if (!d) return;
  if (b.dataset.track) {
    await send('job.save', { company: d.company, role: d.title, url: d.url, location: d.location, source: d.source, jdText: d.description || '', status: 'To Apply' });
    await send('discovered.update', { ...d, state: 'tracked' });
  } else {
    await send('discovered.update', { ...d, state: 'dismissed' });
  }
  loadAll();
};
$('pollNow').onclick = async () => { $('pollNow').textContent = '…'; await send('poll.now'); $('pollNow').textContent = '🔄 Check now'; loadAll(); };

// ---------- outreach ----------
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
  const jobId = Number($('c_job').value) || null;
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
    jobId: Number($('c_job').value) || null,
    recipients, subject: $('c_subject').value, body: $('c_body').value,
    provider: $('c_body').dataset.provider || '',
  });
  $('sendres').textContent = res?.ok
    ? res.data.map((r) => `${r.to}: ${r.status}${r.error ? ` (${r.error})` : ''}`).join('\n')
    : `Send failed: ${res?.error}`;
  loadAll();
};

loadAll();
