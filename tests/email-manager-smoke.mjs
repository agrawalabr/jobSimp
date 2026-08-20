// Smoke: durable enqueue → create (exact meta) → patch gmailMessageId.
// Run: node tests/email-manager-smoke.mjs
import assert from 'node:assert/strict';

const store = Object.create(null);
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === 'string') return { [keys]: store[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) out[k] = store[k];
          return out;
        }
        const out = {};
        for (const k of Object.keys(keys || {})) out[k] = store[k] ?? keys[k];
        return out;
      },
      async set(obj) {
        Object.assign(store, obj);
      },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
    },
  },
  alarms: {
    async get() { return null; },
    create() {},
    async clear() {},
    onAlarm: { addListener() {} },
  },
  runtime: { lastError: null },
};

const {
  finalizeNativeSend,
  allocBeaconId,
  resolveRegisterMessageId,
  drainEmailTxs,
} = await import('../src/email/manager.js');

const TX_KEY = 'jobsimp_email_txs';

assert.equal(resolveRegisterMessageId({ ok: true, id: 'hard' }, { id: 'found' }), 'hard');
assert.equal(resolveRegisterMessageId({ ok: false, reason: 'x' }, { id: 'found' }), 'found');

const beaconId = allocBeaconId();
assert.match(beaconId, /^[0-9a-f-]{36}$/i);

const posts = [];
const patches = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('googleapis.com')) {
    return {
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
      json: async () => ({ error: 'unauthorized' }),
    };
  }
  if (u.includes('/v1/api/beacon/pixel') && opts?.method === 'POST') {
    const body = JSON.parse(opts.body);
    posts.push(body);
    // Simulate Cloud Run keysExact rejection if gmailMessageId sneaks in
    if (body.meta && 'gmailMessageId' in body.meta) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          msg: 'meta must be exactly { source, to, from, subject, sentAt }',
          data: [],
        }),
      };
    }
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ msg: 'success', data: [{ id: body.id }] }),
    };
  }
  if (u.includes('/v1/api/beacon/pixel/') && opts?.method === 'PATCH') {
    const body = JSON.parse(opts.body);
    patches.push({ url: u, body });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ msg: 'success', data: [{ id: beaconId, meta: body.meta }] }),
    };
  }
  return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
};

const res = await finalizeNativeSend({
  beaconId,
  to: ['Name <a@x.com>', 'b@y.com'],
  from: 'Me <me@gmail.com>',
  subject: 'Hello',
  source: 'gmail/google',
  sentAt: 'Fri, Aug 7, 2026, 2:37 PM',
  gmailMessageIdHint: '19fdd8451cc64222',
});
assert.equal(res.ok, true);

await new Promise((r) => setTimeout(r, 80));
await drainEmailTxs();
await new Promise((r) => setTimeout(r, 80));

assert.equal(posts.length, 1, 'createPixel once');
assert.deepEqual(Object.keys(posts[0].meta).sort(), ['from', 'sentAt', 'source', 'subject', 'to']);
assert.equal(posts[0].id, beaconId);
assert.equal(patches.length, 1, 'patchBeaconMessageId once');
assert.equal(patches[0].body.meta.gmailMessageId, '19fdd8451cc64222');

const txs = store[TX_KEY];
assert.ok(!txs || txs.length === 0, 'tx cleared after register');

globalThis.fetch = origFetch;
console.log('email-manager smoke ok', {
  beaconId,
  created: posts[0].meta.source,
  patched: patches[0].body.meta.gmailMessageId,
});
