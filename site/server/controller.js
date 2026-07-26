const store = require('./db');

const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENT_AT_RE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}, \d{1,2}:\d{2}\s*[AP]M$/;
const CREATE_KEYS = ['id', 'count', 'meta'];
const META_KEYS = ['source', 'to', 'from', 'subject', 'sentAt'];

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function keysExact(obj, allowed) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  return keys.length === allowed.length && allowed.every((k) => keys.includes(k));
}

function keysSubset(obj, allowed) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.every((k) => allowed.includes(k));
}

function isEmail(v) {
  return typeof v === 'string' && EMAIL_RE.test(v.trim());
}

function ok(res, status, data) {
  res.status(status).json({ msg: 'success', data });
}

function fail(res, status, msg) {
  res.status(status).json({ msg: msg || 'error', data: [] });
}

function assertCreate(body) {
  if (!keysExact(body, CREATE_KEYS)) {
    throw err(400, 'body must be exactly { id, count, meta }');
  }
  const { id, count, meta } = body;
  if (typeof id !== 'string' || !id.trim()) throw err(400, 'id must be a non-empty string');
  if (count !== 0) throw err(400, 'count must be 0');
  if (!keysExact(meta, META_KEYS)) {
    throw err(400, 'meta must be exactly { source, to, from, subject, sentAt }');
  }
  if (typeof meta.source !== 'string' || !meta.source.trim()) {
    throw err(400, 'meta.source must be a non-empty string');
  }
  if (!Array.isArray(meta.to) || !meta.to.length || !meta.to.every(isEmail)) {
    throw err(400, 'meta.to must be a non-empty array of valid emails');
  }
  if (!isEmail(meta.from)) throw err(400, 'meta.from must be a valid email');
  if (typeof meta.subject !== 'string') throw err(400, 'meta.subject must be a string');
  if (typeof meta.sentAt !== 'string' || !SENT_AT_RE.test(meta.sentAt.replace(/\u202f/g, ' '))) {
    throw err(400, 'meta.sentAt must look like "Sat, Jul 25, 2026, 9:56 PM"');
  }
  return {
    id: id.trim(),
    meta: {
      source: meta.source.trim(),
      to: meta.to.map((e) => e.trim().toLowerCase()),
      from: meta.from.trim().toLowerCase(),
      subject: meta.subject,
      sentAt: meta.sentAt.replace(/\u202f/g, ' '),
    },
  };
}

/** Returns { id?, to?, from? } with emails lowercased. */
function assertFilter(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw err(400, 'filter must be a JSON object');
  }
  if (!keysSubset(body, ['id', 'meta'])) {
    throw err(400, 'filter may only include id and/or meta');
  }
  const out = {};
  if (body.id !== undefined) {
    if (typeof body.id !== 'string' || !body.id.trim()) {
      throw err(400, 'id must be a non-empty string');
    }
    out.id = body.id.trim();
  }
  if (body.meta !== undefined) {
    if (!keysSubset(body.meta, ['to', 'from'])) {
      throw err(400, 'meta may only include to and/or from');
    }
    if (body.meta.to !== undefined) {
      if (!isEmail(body.meta.to)) throw err(400, 'meta.to must be a valid email string');
      out.to = body.meta.to.trim().toLowerCase();
    }
    if (body.meta.from !== undefined) {
      if (!isEmail(body.meta.from)) throw err(400, 'meta.from must be a valid email string');
      out.from = body.meta.from.trim().toLowerCase();
    }
  }
  if (out.id == null && out.to == null && out.from == null) {
    throw err(400, 'filter requires id and/or meta.to and/or meta.from');
  }
  return out;
}

function assertEmptyBody(body) {
  if (body == null) return;
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
    throw err(400, 'body must be empty');
  }
}

function beaconId(param) {
  return String(param || '').replace(/\.gif$/i, '').trim();
}

async function create(req, res) {
  const doc = assertCreate(req.body);
  ok(res, 201, [await store.register(doc)]);
}

async function pixel(req, res) {
  try { await store.hit(beaconId(req.params.id)); } catch { /* always return GIF */ }
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL_GIF.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.status(200).end(PIXEL_GIF);
}

async function list(req, res) {
  ok(res, 200, await store.list(assertFilter(req.body)));
}

async function reset(req, res) {
  assertEmptyBody(req.body);
  const id = beaconId(req.params.id);
  if (!id) throw err(400, 'id is required');
  const doc = await store.reset(id);
  if (!doc) throw err(404, 'Beacon not found');
  ok(res, 200, [doc]);
}

async function destroy(req, res) {
  ok(res, 200, await store.remove(assertFilter(req.body)));
}

module.exports = { create, pixel, list, reset, destroy, ok, fail };
