// EmailManager — shared orchestrator for Outreach (API send) and Gmail mail-track
// (native send). Local beaconId for the pixel; harden first; register once with
// full meta (incl. gmailMessageId). Harden→register is durable: chrome.storage
// + alarms; tab reload/close cannot cancel it.

import {
  appendSignature,
  appendSignatureHtml,
  bodyEndsWithSignature,
  ensureNamePlaceholder,
  generalizeGreeting,
  personalizeBody,
} from './draft-email.js';
import {
  sendEmail,
  isAuthFailure,
  hardenSentCopy,
  findSentMessageByBeacon,
} from './gmail.js';
import {
  createPixel,
  extractBeaconId,
  formatBeaconSentAt,
  cleanEmail,
  stripBeaconPixelHtml,
  patchBeaconMessageId,
  resetBeacon,
} from './beacon.js';
import { normalizeRecipients, recipientGreetingName } from '../static/recipients.js';
import { email as emailDao } from '../dao/index.js';

const TX_KEY = 'jobsimp_email_txs';
const TX_ALARM = 'jobsimp-email-tx-drain';
const TX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const TX_MAX_ATTEMPTS = 40;

const SCHEDULED_WATCH_KEY = 'jobsimp_scheduled_beacon_watches';
const SCHEDULED_ALARM = 'jobsimp-scheduled-beacon-check';
const SCHEDULED_WATCH_MAX_AGE_MS = 32 * 24 * 3600 * 1000;

function toEmailList(v) {
  if (Array.isArray(v)) {
    return v.map(cleanEmail).filter(Boolean).filter((e, i, a) => a.indexOf(e) === i);
  }
  return String(v || '')
    .split(/[,;]/)
    .map(cleanEmail)
    .filter(Boolean)
    .filter((e, i, a) => a.indexOf(e) === i);
}

async function getTxs() {
  const got = await chrome.storage.local.get(TX_KEY);
  const list = got?.[TX_KEY];
  return Array.isArray(list) ? list : [];
}

async function setTxs(list) {
  await chrome.storage.local.set({ [TX_KEY]: list });
}

async function upsertTx(tx) {
  const list = await getTxs();
  const i = list.findIndex((t) => t.id === tx.id || t.beaconId === tx.beaconId);
  if (i >= 0) list[i] = { ...list[i], ...tx };
  else list.push(tx);
  await setTxs(list);
  await ensureTxAlarm();
}

async function removeTx(txId) {
  const list = (await getTxs()).filter((t) => t.id !== txId);
  await setTxs(list);
  if (!list.length) await chrome.alarms.clear(TX_ALARM);
}

async function ensureTxAlarm() {
  const existing = await chrome.alarms.get(TX_ALARM);
  if (!existing) chrome.alarms.create(TX_ALARM, { periodInMinutes: 1 });
}

/** Allocate a local beacon id for the pixel — not registered on Cloud Run yet. */
export function allocBeaconId(reuse) {
  const r = String(reuse || '').trim();
  if (r) return r;
  return crypto.randomUUID();
}

function buildRegisterMeta(tx) {
  return {
    source: tx.source || 'jobSimp',
    to: toEmailList(tx.to),
    from: cleanEmail(tx.from),
    subject: String(tx.subject || ''),
    sentAt: String(tx.sentAt || formatBeaconSentAt()),
    gmailMessageId: String(tx.gmailMessageId || '').trim(),
  };
}

/**
 * Prefer the hardened (re-inserted) message id; if harden failed, still use the
 * Sent copy we found so Cloud Run register is not blocked forever.
 */
export function resolveRegisterMessageId(hardenResult, found) {
  if (hardenResult?.ok && hardenResult.id) return String(hardenResult.id);
  return String(found?.id || '').trim();
}

async function registerFull(tx) {
  const meta = buildRegisterMeta(tx);
  const gmailMessageId = String(meta.gmailMessageId || '').trim();
  if (!gmailMessageId) throw new Error('gmailMessageId required for register');
  if (!meta.from || !meta.to.length) throw new Error('from/to required for register');
  // Cloud Run create rejects gmailMessageId (keysExact on META_KEYS). Create
  // first (409 = already exists on reply reuse), reset count, then PATCH
  // meta.gmailMessageId — newest Sent legacy-last-message-id.
  const { gmailMessageId: _drop, ...createMeta } = meta;
  await createPixel({ id: tx.beaconId, count: 0, meta: createMeta });
  try {
    await resetBeacon(tx.beaconId);
  } catch (e) {
    console.warn('[email] resetBeacon after create', tx.beaconId, e.message);
  }
  await patchBeaconMessageId(tx.beaconId, gmailMessageId);
}

async function processTx(tx) {
  const next = { ...tx, attempts: (tx.attempts || 0) + 1 };
  if (Date.now() - (tx.createdAt || 0) > TX_MAX_AGE_MS) {
    console.error('[email] tx expired', tx.beaconId, tx.stage);
    await removeTx(tx.id);
    return;
  }
  if (next.attempts > TX_MAX_ATTEMPTS) {
    console.error('[email] tx max attempts', tx.beaconId, tx.stage);
    await removeTx(tx.id);
    return;
  }
  await upsertTx(next);

  try {
    if (next.stage === 'harden') {
      let found = null;
      if (next.originalGmailId) {
        found = { id: next.originalGmailId, threadId: next.threadId || undefined };
      } else {
        found = await findSentMessageByBeacon(next.beaconId, {
          to: next.to,
          retries: 3,
          delayMs: 1500,
        });
      }
      if (!found) {
        console.warn('[email] harden: sent message not found yet', next.beaconId);
        await ensureTxAlarm();
        return; // retry on alarm
      }
      const result = await hardenSentCopy(found);
      const mid = resolveRegisterMessageId(result, found);
      if (!mid) {
        console.warn('[email] harden: no message id to register', next.beaconId, result?.reason);
        await ensureTxAlarm();
        return;
      }
      if (!result?.ok) {
        // Harden is best-effort (self-hit neutralization). Register must still
        // run — otherwise the outbound live pixel never lands on Cloud Run.
        console.warn('[email] harden failed; registering with found id', next.beaconId, result?.reason);
      }
      next.gmailMessageId = mid;
      next.threadId = result?.threadId || next.threadId || found.threadId || '';
      next.stage = 'register';
      await upsertTx(next);
      try {
        const row = await emailDao.findByBeacon(next.beaconId);
        if (row) {
          await emailDao.post({
            id: row.id,
            gmailId: mid,
            threadId: next.threadId || row.threadId || '',
            lastActivityAt: Date.now(),
            body: '',
          });
        }
      } catch { /* local log is best-effort */ }
    }

    if (next.stage === 'register') {
      if (!next.gmailMessageId) {
        next.stage = 'harden';
        await upsertTx(next);
        await ensureTxAlarm();
        return;
      }
      await registerFull(next);
      await removeTx(next.id);
      console.info('[email] registered beacon', next.beaconId, next.gmailMessageId);
    }
  } catch (e) {
    console.warn('[email] processTx error', next.beaconId, next.stage, e.message);
    await upsertTx(next);
    await ensureTxAlarm();
  }
}

/** Drain all pending harden→register transactions. Safe to call anytime. */
export async function drainEmailTxs() {
  const list = await getTxs();
  if (!list.length) {
    await chrome.alarms.clear(TX_ALARM);
    return;
  }
  for (const tx of list) {
    await processTx(tx);
  }
  const left = await getTxs();
  if (left.length) await ensureTxAlarm();
  else await chrome.alarms.clear(TX_ALARM);
}

export function installEmailTxAlarms() {
  chrome.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm.name === TX_ALARM) {
      drainEmailTxs().catch((e) => console.warn('[email] tx drain failed', e.message));
    }
    if (alarm.name === SCHEDULED_ALARM) {
      checkScheduledWatches().catch((e) => console.warn('[beacon] scheduled check failed', e.message));
    }
  });
}

/** Enqueue after API send or native send — persists before returning. */
export async function enqueueHardenRegister(partial) {
  const beaconId = String(partial.beaconId || '').trim();
  if (!beaconId) throw new Error('beaconId required');
  const tx = {
    id: `tx_${beaconId}`,
    beaconId,
    stage: partial.originalGmailId || partial.gmailMessageIdHint ? 'harden' : 'harden',
    source: partial.source || 'jobSimp',
    to: toEmailList(partial.to),
    from: cleanEmail(partial.from),
    subject: String(partial.subject || ''),
    sentAt: String(partial.sentAt || formatBeaconSentAt()),
    originalGmailId: partial.originalGmailId || '',
    threadId: partial.threadId || '',
    gmailMessageId: '',
    attempts: 0,
    createdAt: Date.now(),
  };
  await upsertTx(tx);
  await ensureTxAlarm();
  // Kick immediately; alarm is backup if SW sleeps / tab dies mid-flight.
  processTx(tx).catch((e) => console.warn('[email] immediate processTx', e.message));
  return { ok: true, beaconId, txId: tx.id };
}

/**
 * Native Gmail compose: pixel already live in DOM. Enqueue find→harden→register.
 * Optional gmailMessageIdHint from data-legacy-last-*-message-id.
 */
export async function finalizeNativeSend({
  beaconId, to, from, subject, source = 'gmail/google', sentAt, gmailMessageIdHint,
} = {}) {
  const id = String(beaconId || '').trim();
  if (!id) return { ok: false, reason: 'no beaconId' };
  const toList = toEmailList(to);
  const fromE = cleanEmail(from);
  if (!fromE || !toList.length) return { ok: false, reason: 'missing from/to' };
  return enqueueHardenRegister({
    beaconId: id,
    source,
    to: toList,
    from: fromE,
    subject: subject || '',
    sentAt: sentAt || formatBeaconSentAt(),
    originalGmailId: gmailMessageIdHint || '',
  });
}

// ---------- scheduled send watches (register deferred until actually sent) ----------

async function getScheduledWatches() {
  const got = await chrome.storage.local.get(SCHEDULED_WATCH_KEY);
  const list = got?.[SCHEDULED_WATCH_KEY];
  return Array.isArray(list) ? list : [];
}

async function setScheduledWatches(list) {
  await chrome.storage.local.set({ [SCHEDULED_WATCH_KEY]: list });
}

async function ensureScheduledAlarm() {
  const existing = await chrome.alarms.get(SCHEDULED_ALARM);
  if (!existing) chrome.alarms.create(SCHEDULED_ALARM, { periodInMinutes: 10 });
}

export async function watchScheduledSend({ beaconId, to, meta } = {}) {
  const id = String(beaconId || '').trim();
  if (!id) return { ok: false, reason: 'no beaconId' };
  const watches = await getScheduledWatches();
  if (!watches.some((w) => w.beaconId === id)) {
    watches.push({
      beaconId: id,
      to: toEmailList(to || meta?.to),
      meta: {
        source: meta?.source || 'gmail/google',
        to: toEmailList(to || meta?.to),
        from: cleanEmail(meta?.from),
        subject: meta?.subject || '',
        sentAt: meta?.sentAt || formatBeaconSentAt(),
      },
      addedAt: Date.now(),
    });
    await setScheduledWatches(watches);
  }
  await ensureScheduledAlarm();
  return { ok: true };
}

async function checkScheduledWatches() {
  const watches = await getScheduledWatches();
  if (!watches.length) {
    await chrome.alarms.clear(SCHEDULED_ALARM);
    return;
  }
  const remaining = [];
  for (const w of watches) {
    if (Date.now() - (w.addedAt || 0) > SCHEDULED_WATCH_MAX_AGE_MS) {
      console.warn('[beacon] scheduled watch expired', w.beaconId);
      continue;
    }
    let found = null;
    try {
      found = await findSentMessageByBeacon(w.beaconId, { to: w.to, retries: 1, delayMs: 0 });
    } catch (e) {
      console.warn('[beacon] scheduled watch search failed', w.beaconId, e.message);
    }
    if (!found) {
      remaining.push(w);
      continue;
    }
    // Enqueue durable harden→register (no early createPixel).
    try {
      await enqueueHardenRegister({
        beaconId: w.beaconId,
        source: w.meta?.source || 'gmail/google',
        to: w.to,
        from: w.meta?.from,
        subject: w.meta?.subject || '',
        sentAt: w.meta?.sentAt || formatBeaconSentAt(),
        originalGmailId: found.id,
        threadId: found.threadId,
      });
    } catch (e) {
      console.warn('[beacon] scheduled enqueue failed', w.beaconId, e.message);
      remaining.push(w);
    }
  }
  await setScheduledWatches(remaining);
  if (!remaining.length) await chrome.alarms.clear(SCHEDULED_ALARM);
}

/**
 * Outreach / API send path.
 * Local beaconId only until after harden; then durable register with full meta.
 */
export async function sendTrackedEmail(p, { buildResumeAttachment, getSettings, getUserEmail } = {}) {
  const s = await getSettings();
  const list = normalizeRecipients(p.recipients);
  if (!list.length) throw new Error('No valid email addresses found.');

  const subject = String(p.subject || '').trim();
  if (!subject) throw new Error('Subject is required.');
  if (!String(p.body || '').trim()) throw new Error('Body is required.');

  const group = !!p.group && list.length > 1;
  const fanOut = !group && list.length > 1;

  let body = String(p.body || '');
  let bodyHtml = String(p.bodyHtml || '').trim();
  const sig = p.signature ?? s.emailTemplate?.signature ?? '';
  if (fanOut) body = ensureNamePlaceholder(body);
  if (group) body = generalizeGreeting(body, list.map(recipientGreetingName));
  const alreadySigned = !!(sig && (
    bodyEndsWithSignature(bodyHtml || body, sig) || bodyEndsWithSignature(body, sig)
  ));
  if (sig && !alreadySigned) {
    body = appendSignature(body, sig);
    if (bodyHtml) bodyHtml = appendSignatureHtml(bodyHtml, sig);
  } else if (sig) {
    body = appendSignature(body, sig);
  }

  if (bodyHtml) {
    if (fanOut && !bodyHtml.includes('{{name}}')) bodyHtml = '';
    else if (group) bodyHtml = generalizeGreeting(bodyHtml, list.map(recipientGreetingName));
  }

  const attachments = [];
  const wantResume = !!p.attach;
  const fileExtras = Array.isArray(p.fileAttachments)
    ? p.fileAttachments
    : (p.fileAttachment?.dataB64 ? [p.fileAttachment] : []);

  if (wantResume) {
    if (!p.resumeId) throw new Error('No resume selected — nothing attached.');
    const built = await buildResumeAttachment(p.resumeId);
    if (!built.attachment) throw new Error(built.error || 'Could not attach resume.');
    attachments.push(built.attachment);
  }
  for (const f of fileExtras) {
    if (!f?.dataB64) continue;
    attachments.push({
      filename: f.filename || 'attachment',
      mime: f.mime || 'application/octet-stream',
      dataB64: f.dataB64,
    });
  }
  if (fileExtras.length && attachments.length === (wantResume ? 1 : 0)) {
    throw new Error('Could not attach file.');
  }

  const wantTrack = p.track !== false;
  const fromEmail = cleanEmail(
    (typeof getUserEmail === 'function' ? await getUserEmail() : '') || s.gmail?.fromEmail || '',
  );
  const replyThreadId = String(p.threadId || '').trim();
  const replyEmailId = String(p.emailId || '').trim();
  let existingThreadRow = null;
  if (replyEmailId) {
    try { existingThreadRow = await emailDao.get(replyEmailId); } catch { /* ignore */ }
  }
  if (!existingThreadRow && replyThreadId) {
    try { existingThreadRow = await emailDao.findByThreadId(replyThreadId); } catch { /* ignore */ }
  }
  const reuseId = wantTrack
    ? (p.beaconId
      || existingThreadRow?.beaconId
      || existingThreadRow?.jobsimp?.beaconId
      || extractBeaconId(bodyHtml)
      || extractBeaconId(body)
      || '')
    : '';
  // Reply reuse: clear open count before the new outbound pixel is live.
  if (wantTrack && reuseId && (replyThreadId || replyEmailId || p.beaconId)) {
    try { await resetBeacon(reuseId); } catch { /* new id or offline — registerFull will reset */ }
  }

  const results = [];

  async function sendOne({ to, toName, greeting, beaconId }) {
    let html = bodyHtml ? personalizeBody(bodyHtml, greeting) : '';
    const plain = personalizeBody(body, greeting);
    if (html) html = stripBeaconPixelHtml(html);
    // Live pixel via sendEmail(beaconId) → wrapHtmlDocument; do not register yet.
    const toStr = Array.isArray(to) ? to.join(', ') : to;
    const now = Date.now();
    const rec = {
      ...(existingThreadRow?.id ? { id: existingThreadRow.id } : {}),
      jobId: p.jobId ?? existingThreadRow?.jobId ?? null,
      to: toStr,
      toName,
      subject,
      body: '',
      snippet: String(plain || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      provider: p.provider || '',
      resumeId: wantResume ? p.resumeId : '',
      attached: attachments.length > 0,
      attachMeta: attachments.map((a) => ({
        filename: a.filename || 'attachment',
        mime: a.mime || 'application/octet-stream',
        size: a.size || Math.floor(String(a.dataB64 || '').length * 0.75),
      })),
      beaconId: beaconId || existingThreadRow?.beaconId || '',
      jobsimp: (beaconId || existingThreadRow?.beaconId)
        ? { subject, to: toStr, beaconId: beaconId || existingThreadRow?.beaconId }
        : undefined,
      status: 'draft',
      gmailId: '',
      threadId: replyThreadId || existingThreadRow?.threadId || '',
      lastActivityAt: now,
    };
    try {
      const sent = await sendEmail({
        to,
        subject,
        body: plain,
        bodyHtml: html,
        fromName: s.gmail?.fromName || '',
        fromAddress: fromEmail || undefined,
        attachments,
        beaconId: beaconId || undefined,
        threadId: replyThreadId || undefined,
        inReplyTo: p.inReplyTo || undefined,
        references: p.references || p.inReplyTo || undefined,
      });
      // Prefer the thread we asked to join (reply), falling back to Gmail's return value.
      rec.gmailId = sent.id;
      rec.threadId = replyThreadId || sent.threadId || '';
      rec.status = 'sent';
      rec.sentAt = now;
      rec.lastActivityAt = now;
      if (beaconId) {
        await enqueueHardenRegister({
          beaconId,
          source: 'jobSimp',
          to: Array.isArray(to) ? to : [to],
          from: fromEmail,
          subject,
          sentAt: formatBeaconSentAt(new Date(rec.sentAt)),
          originalGmailId: sent.id,
          threadId: rec.threadId || sent.threadId,
        });
      }
    } catch (e) {
      rec.status = 'failed';
      rec.error = e.message;
    }
    const saved = await emailDao.post(rec);
    return {
      to: rec.to,
      status: rec.status,
      error: rec.error || '',
      beaconId: rec.beaconId || '',
      gmailId: rec.gmailId || '',
      threadId: rec.threadId || '',
      emailId: saved?.id || existingThreadRow?.id || '',
    };
  }

  if (group) {
    const toList = list.map((r) => r.email);
    const beaconId = wantTrack ? allocBeaconId(reuseId) : '';
    results.push(await sendOne({
      to: toList,
      toName: list.map((r) => (recipientGreetingName(r) ? r.text : '')).filter(Boolean).join(', '),
      greeting: '',
      beaconId,
    }));
    return results;
  }

  for (const r of list) {
    const greeting = recipientGreetingName(r);
    const beaconId = wantTrack
      ? allocBeaconId(list.length === 1 ? reuseId : '')
      : '';
    const out = await sendOne({
      to: r.email,
      toName: greeting ? r.text : '',
      greeting,
      beaconId,
    });
    results.push(out);
    if (out.status === 'failed' && isAuthFailure(out.error)) {
      for (const skipped of list.slice(results.length)) {
        results.push({ to: skipped.email, status: 'failed', error: 'Skipped — sign in again and retry.' });
      }
      break;
    }
  }
  return results;
}

export { extractBeaconId, stripBeaconPixelHtml, formatBeaconSentAt };
