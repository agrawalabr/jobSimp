// Outreach tab: AI email composer + sent log.
//
// Note the import: recipient parsing comes from static/recipients.js, NOT from
// service/gmail.js — that module pulls in oauth.js and the whole DAO layer,
// which has no business being loaded into a UI page.
import { parseRecipientList, formatRecipientToken, recipientGreetingName } from '../../../static/recipients.js';
import { $, send, data, esc, isoDate } from '../lib/dom.js';

const TONES = ['Concise', 'Warm', 'Confident', 'Formal', 'Casual', 'Direct', 'Grateful', 'Persuasive'];
const MAX_TONES = 3;
const DEFAULT_CONTEXT = 'Generic cold outreach — introduce yourself and ask for a brief chat.';

let jobs = [];
let emails = [];
let resumes = [];
let recipients = [];
let selectedTones = [];
let signatureTouched = false;
let contextAutoFilled = '';

// Switching to Settings and back re-creates the DOM. Snapshot the in-progress
// email on unmount so a half-written draft is never silently thrown away.
const FORM_IDS = ['c_resume', 'c_job', 'c_context', 'c_subject', 'c_body', 'c_signature'];
let draftSnapshot = null;

function captureDraft() {
  if (!$('c_body')) return null;
  const values = Object.fromEntries(FORM_IDS.map((id) => [id, $(id).value]));
  return {
    values,
    group: $('c_group').checked,
    attach: $('c_attach').checked,
    provider: $('c_body').dataset.provider || '',
    status: $('draftStatus').textContent,
  };
}

function restoreDraft() {
  if (!draftSnapshot) return;
  for (const [id, v] of Object.entries(draftSnapshot.values)) {
    const el = $(id);
    // Selects are repopulated on mount; only restore a still-valid option.
    if (!el) continue;
    if (el.tagName === 'SELECT' && v && ![...el.options].some((o) => o.value === v)) continue;
    el.value = v;
  }
  $('c_group').checked = draftSnapshot.group;
  $('c_attach').checked = draftSnapshot.attach;
  $('c_body').dataset.provider = draftSnapshot.provider;
  $('draftStatus').textContent = draftSnapshot.status;
}

// ---------- recipients ----------

function renderRecipients() {
  $('c_to_chips').innerHTML = recipients.map((r, i) => {
    const named = !!recipientGreetingName(r);
    const tip = named
      ? ` title="${esc(r.email)}" aria-label="${esc(r.text)} (${esc(r.email)})"`
      : ` aria-label="${esc(r.email)}"`;
    return `<span class="recipient-chip${named ? ' has-name' : ''}" data-i="${i}"${tip}>
      <span class="chip-label">${esc(named ? r.text : r.email)}</span>
      <button type="button" class="chip-x" data-rm="${i}" aria-label="Remove ${esc(r.email)}">×</button>
    </span>`;
  }).join('');
  $('c_to_clear').hidden = !recipients.length;
  syncSendMode();
}

/** Parse whatever is in the input (single token or a pasted list) into chips. */
function commitInput() {
  console.log('commitInput started!');
  const input = $('c_to_input');
  const hint = $('c_to_hint');
  const raw = input.value.trim();
  if (!raw) { hint.textContent = ''; return false; }

  const parsed = parseRecipientList(raw);
  if (!parsed.length) {
    hint.textContent = 'No valid address found. Use email@host.com, Name <email@host.com>, or name:email@host.com.';
    return false;
  }
  const known = new Set(recipients.map((r) => r.email));
  const added = parsed.filter((r) => !known.has(r.email));
  recipients.push(...added);
 
  input.value = '';
  const dupes = parsed.length - added.length;
  hint.textContent = dupes
    ? `${added.length} added, ${dupes} already on the list.`
    : '';
  renderRecipients();
  return added.length > 0;
  console.log('recipients done!', recipients);
}

// ---------- send-mode / enablement ----------

function syncSendMode() {
  const n = recipients.length;
  const group = $('c_group').checked;

  // "Group" only means anything with more than one recipient.
  $('c_group').disabled = n < 2;
  $('c_sendMode').textContent = !n
    ? 'Add a recipient to send.'
    : n === 1
      ? 'Sends 1 email.'
      : group
        ? `Sends 1 email with all ${n} recipients on the To line — they see each other.`
        : `Sends ${n} separate emails, each greeted by name where you gave one.`;

  syncSendEnabled();
}

function syncSendEnabled() {
  $('sendBtn').disabled = !(
    recipients.length
    && $('c_subject').value.trim()
    && $('c_body').value.trim()
  );
}

function syncAttach() {
  const box = $('c_attach');
  const none = !$('c_resume').value;
  // Previously this silently sent nothing when no resume existed.
  box.disabled = none;
  if (none) box.checked = false;
  box.closest('.check-row').title = none ? 'Upload a resume first (Account → Resume).' : '';
}

// ---------- tones ----------

function renderTones() {
  $('c_tones').innerHTML = TONES.map((t) => {
    const on = selectedTones.includes(t);
    const capped = !on && selectedTones.length >= MAX_TONES;
    return `<button type="button" class="tone-chip${on ? ' on' : ''}" data-tone="${esc(t)}"${
      capped ? ' disabled' : ''}>${esc(t)}</button>`;
  }).join('');
}

function tonesFromSettings(template) {
  const tokens = String(template?.tone || '').split(/[,/|]+/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return [];
  const exact = TONES.filter((t) => tokens.some((x) => x.toLowerCase() === t.toLowerCase()));
  if (exact.length) return exact.slice(0, MAX_TONES);
  return TONES.filter((t) => tokens.some((x) => {
    const a = x.toLowerCase();
    const b = t.toLowerCase();
    return a.includes(b) || b.includes(a);
  })).slice(0, MAX_TONES);
}

// ---------- job / context ----------

function jobContextText(j) {
  if (!j) return '';
  const jd = String(j.jdText || '').trim();
  if (jd) return jd;
  const summary = String(j.jdExtract?.summary || '').trim();
  if (summary) return summary;
  return (j.jdExtract?.topRequirements || []).filter(Boolean).join('; ');
}

/** Load a job's JD into the context box, without discarding hand-written notes. */
function fillContextFromJob() {
  const jobId = $('c_job').value;
  const next = jobContextText(jobs.find((x) => x.id === jobId));
  const current = $('c_context').value.trim();
  const wasAutoFilled = !current || current === contextAutoFilled;

  if (!wasAutoFilled && !confirm("Replace the context you typed with this job's JD?")) return;

  $('c_context').value = next;
  contextAutoFilled = next;
}

// ---------- rendering ----------

function renderSelectors() {
  const prevJob = $('c_job').value;
  const prevResume = $('c_resume').value;

  $('c_job').innerHTML = '<option value="">— no linked job —</option>'
    + jobs.map((j) => `<option value="${esc(j.id)}">${esc(j.company)} — ${esc(j.role)}</option>`).join('');
  if (prevJob && jobs.some((j) => j.id === prevJob)) $('c_job').value = prevJob;

  $('c_resume').innerHTML = resumes.length
    ? resumes.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}${r.isDefault ? ' (default)' : ''}</option>`).join('')
    : '<option value="">— no resumes —</option>';
  const fallback = resumes.find((r) => r.isDefault)?.id || resumes[0]?.id || '';
  $('c_resume').value = (prevResume && resumes.some((r) => r.id === prevResume)) ? prevResume : fallback;

  syncAttach();
}

function trackPillHtml(state, label) {
  return `<span class="track-pill ${esc(state)}">${esc(label)}</span>`;
}

async function openTrackPill(beaconId) {
  if (!beaconId) return trackPillHtml('untracked', 'Untracked');
  const res = await send('beacon.track', { id: beaconId });
  if (!res?.ok || !res.data) return trackPillHtml('untracked', 'Untracked');
  const count = Number(res.data.count) || 0;
  if (count <= 0) return trackPillHtml('not-opened', 'Not opened');
  if (count === 1) return trackPillHtml('opened', 'Opened');
  return trackPillHtml('opened', `Opened ${count}×`);
}

async function renderSentLog() {
  // Copy before sorting — `emails` is shared module state, not a scratch array.
  const rows = [...emails].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!rows.length) {
    $('emailRows').innerHTML = '<tr><td colspan="5" style="color:var(--muted)">No emails yet.</td></tr>';
    return;
  }

  const pills = await Promise.all(rows.map((m) => (
    m.status === 'sent' ? openTrackPill(m.beaconId) : Promise.resolve('')
  )));

  $('emailRows').innerHTML = rows.map((m, i) => {
    const j = jobs.find((x) => x.id === m.jobId);
    const to = !m.toName
      ? esc(m.to)
      : String(m.to).includes(',')
        ? `${esc(m.toName)} (${esc(m.to)})`
        : `<span title="${esc(m.to)}">${esc(m.toName)}</span>`;
    const status = m.status === 'sent'
      ? `${pills[i]} <span class="yes">sent</span>`
      : m.status === 'failed'
        ? `<span class="no">failed</span> <span class="unk">${esc(m.error || '')}</span>`
        : esc(m.status);
    return `<tr>
      <td>${isoDate(m.sentAt || m.createdAt)}</td>
      <td>${to}${m.attached ? ' <span class="badge">📎</span>' : ''}</td>
      <td>${esc(m.subject)}</td>
      <td>${j ? esc(j.company) : ''}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
}

// ---------- drafting ----------

function setDraftLoading(on) {
  $('c_body_wrap').classList.toggle('loading', !!on);
  const skel = $('c_body_skel');
  skel.hidden = !on;
  skel.setAttribute('aria-hidden', on ? 'false' : 'true');
  ['c_subject', 'c_body', 'draftBtn', 'regenBtn', 'sendBtn'].forEach((id) => { $(id).disabled = !!on; });
}

async function runDraft(statusLabel) {
  console.log('runDraft', statusLabel);
  commitInput();
  if (!recipients.length) {
    $('draftStatus').textContent = 'Add at least one recipient.';
    return;
  }

  const j = jobs.find((x) => x.id === $('c_job').value);
  const context = $('c_context').value.trim() || jobContextText(j) || DEFAULT_CONTEXT;

  const prev = { subject: $('c_subject').value, body: $('c_body').value };
  $('c_subject').value = '';
  $('c_body').value = '';
  setDraftLoading(true);
  $('draftStatus').textContent = statusLabel;

  const res = await send('ai.draft', {
    context,
    company: j?.company || '',
    role: j?.role || '',
    jobId: j?.id || null,
    resumeId: $('c_resume').value || null,
    tones: selectedTones.slice(0, MAX_TONES),
    recipients,
    group: $('c_group').checked,
    signature: $('c_signature').value,
  });

  setDraftLoading(false);

  if (res?.ok && res.data?.via === 'llm' && res.data.subject && res.data.body) {
    $('c_subject').value = res.data.subject;
    $('c_body').value = res.data.body;
    $('c_body').dataset.provider = res.data.provider || '';
    // The AI only invents a signature when the field was empty; don't clobber edits.
    if (res.data.signature && !$('c_signature').value.trim()) $('c_signature').value = res.data.signature;
    $('draftStatus').textContent = `Written with ${res.data.provider}${
      res.data.model ? ` / ${res.data.model}` : ''}. Review before sending.`;
    syncSendEnabled();
    return;
  }

  // Restore the previous draft on failure rather than leaving the box empty.
  $('c_subject').value = prev.subject;
  $('c_body').value = prev.body;
  let err = res?.error;
  if (!err && res?.ok) {
    err = res.data?.via !== 'llm'
      ? 'Stale service worker — open chrome://extensions → Reload JobSimp, then retry.'
      : 'Draft response incomplete (missing subject/body). Try regenerate.';
  }
  $('draftStatus').textContent = `Write failed: ${err || 'No response — reload JobSimp in chrome://extensions and retry.'}`;
  syncSendEnabled();
}

// ---------- sending ----------

async function doSend() {
  commitInput();
  const out = $('sendres');
  if (!recipients.length) { out.textContent = 'Add at least one recipient.'; return; }
  if (!$('c_subject').value.trim() || !$('c_body').value.trim()) {
    out.textContent = 'Subject and body required (use "Write with AI" or write them yourself).';
    return;
  }

  const group = $('c_group').checked && recipients.length > 1;
  const label = recipients.map(formatRecipientToken).join(', ');
  const what = group ? `1 group email to ${recipients.length} people` : `${recipients.length} email(s)`;
  if (!confirm(`Send ${what}?\n\n${label}`)) return;

  $('sendBtn').disabled = true;
  out.textContent = 'Sending…';

  const res = await send('email.send', {
    jobId: $('c_job').value || null,
    recipients,
    subject: $('c_subject').value,
    body: $('c_body').value,
    // Sent separately from the body so edits here take effect (the service
    // worker appends it at send time).
    signature: $('c_signature').value,
    provider: $('c_body').dataset.provider || '',
    group: $('c_group').checked,
    resumeId: $('c_resume').value || null,
    attach: $('c_attach').checked,
  });

  if (!res?.ok) {
    out.textContent = `Send failed: ${res?.error || 'unknown error'}`;
    syncSendEnabled();
    return;
  }

  const results = Array.isArray(res.data) ? res.data : [];
  if (!results.length) {
    out.textContent = 'Send returned no result — check the Sent log below.';
  } else {
    out.textContent = results
      .map((r) => `${r.to}: ${r.status}${r.error ? ` (${r.error})` : ''}`)
      .join('\n');
  }

  // Clear the message but keep the setup (resume, job, tones, signature) so the
  // next outreach doesn't start from scratch.
  if (results.length && results.every((r) => r.status === 'sent')) {
    recipients = [];
    $('c_subject').value = '';
    $('c_body').value = '';
    $('c_to_input').value = '';
    $('draftStatus').textContent = '';
    renderRecipients();
  }

  emails = await data('emails.list', undefined, []);
  renderSentLog();
  syncSendEnabled();
}

// ---------- wiring ----------

function initEvents() {
  $('c_job').onchange = fillContextFromJob;
  $('c_resume').onchange = syncAttach;

  $('c_to_add').onclick = commitInput;
  $('c_to_clear').onclick = () => { recipients = []; renderRecipients(); };

  $('c_to_input').onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); commitInput(); }
    if (e.key === 'Backspace' && !e.target.value && recipients.length) {
      recipients.pop();
      renderRecipients();
    }
  };
  $('c_to_input').onpaste = (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (!/[,;\n<]/.test(text)) return; // single token — let the default paste happen
    e.preventDefault();
    e.target.value = text;
    commitInput();
  };
  $('c_to_input').onblur = (e) => {
    // Don't fight the Add button: its click would fire after this blur.
    if (e.relatedTarget?.id === 'c_to_add') return;
    commitInput();
  };

  $('c_to_box').onclick = (e) => {
    if (e.target === $('c_to_box') || e.target === $('c_to_chips')) $('c_to_input').focus();
  };
  $('c_to_chips').onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      e.stopPropagation();
      recipients.splice(Number(rm.dataset.rm), 1);
      renderRecipients();
      return;
    }
    const chip = e.target.closest('.recipient-chip[data-i]');
    if (!chip) return;
    const [r] = recipients.splice(Number(chip.dataset.i), 1);
    if (!r) return;
    renderRecipients();
    $('c_to_input').value = formatRecipientToken(r);
    $('c_to_input').focus();
  };

  $('c_tones').onclick = (e) => {
    const b = e.target.closest('[data-tone]');
    if (!b || b.disabled) return;
    const t = b.dataset.tone;
    selectedTones = selectedTones.includes(t)
      ? selectedTones.filter((x) => x !== t)
      : [...selectedTones, t].slice(0, MAX_TONES);
    renderTones();
  };

  $('c_group').onchange = syncSendMode;
  $('c_subject').oninput = syncSendEnabled;
  $('c_body').oninput = syncSendEnabled;
  $('c_signature').oninput = () => { signatureTouched = true; };

  $('draftBtn').onclick = () => runDraft('Writing with AI…');
  $('regenBtn').onclick = () => runDraft('Regenerating…');
  $('sendBtn').onclick = doSend;
}

export async function mount(_root, params = {}) {
  initEvents();

  const [j, e, r, s] = await Promise.all([
    data('job.list', undefined, []),
    data('emails.list', undefined, []),
    data('resumes.list', undefined, []),
    data('defaults.get', undefined, null),
  ]);
  jobs = j;
  emails = e;
  resumes = r;

  renderSelectors();
  restoreDraft();

  const template = s?.emailTemplate;
  if (template && !signatureTouched) $('c_signature').value = template.signature || '';
  if (!selectedTones.length) selectedTones = tonesFromSettings(template);

  // Arrived here from the tracker's ✉ button.
  if (params.jobId && jobs.some((x) => x.id === params.jobId)) {
    $('c_job').value = params.jobId;
    const ctx = jobContextText(jobs.find((x) => x.id === params.jobId));
    if (!$('c_context').value.trim() || $('c_context').value.trim() === contextAutoFilled) {
      $('c_context').value = ctx;
      contextAutoFilled = ctx;
    }
  }

  renderTones();
  renderRecipients();
  renderSentLog();
  syncAttach();
  syncSendMode();
}

export function unmount() {
  draftSnapshot = captureDraft();
}
