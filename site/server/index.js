const cors = require('cors');
const express = require('express');
const path = require('path');
const store = require('./db');

const PORT = Number(process.env.PORT) || 8787;
const API_KEY = process.env.BEACON_API_KEY || '';

/** 1×1 transparent GIF */
const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

function sendError(res, err) {
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Server error',
    ...(err.payload ? { beacon: err.payload } : {}),
  });
}

/** Strip optional .gif / .json suffix and trim. */
function normalizeBeaconId(id) {
  return String(id || '').replace(/\.(gif|json)$/i, '').trim();
}

/** Optional gate for register / track / reset / delete. Pixel stays public. */
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const header = req.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : '';
  const key = bearer || req.get('x-beacon-key') || '';
  if (key !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

async function registerHandler(req, res) {
  try {
    const { id, meta, ...rest } = req.body || {};
    const details = meta && typeof meta === 'object'
      ? { ...rest, ...meta }
      : { ...rest, ...(meta != null ? { note: meta } : {}) };
    const payload = await store.registerBeacon({ id, meta: details });
    res.status(201).json(payload);
  } catch (err) {
    sendError(res, err);
  }
}

/** Public: increment count and return 1×1 GIF (never fail the image load). */
async function pixelHandler(req, res) {
  const id = normalizeBeaconId(req.params.id);
  try {
    await store.hitBeacon(id);
  } catch {
    // Still return a pixel — never break the email client's image load.
  }

  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL_GIF.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.status(200).end(PIXEL_GIF);
}

async function trackHandler(req, res) {
  const id = normalizeBeaconId(req.params.id);
  try {
    const payload = await store.getBeacon(id);
    if (!payload) {
      res.status(404).json({ error: 'Beacon not found', id });
      return;
    }
    res.json(payload);
  } catch (err) {
    sendError(res, err);
  }
}

async function resetHandler(req, res) {
  const id = normalizeBeaconId(req.params.id);
  try {
    const payload = await store.resetBeacon(id);
    if (!payload) {
      res.status(404).json({ error: 'Beacon not found', id });
      return;
    }
    res.json(payload);
  } catch (err) {
    sendError(res, err);
  }
}

/** Idempotent: { id, deleted: true|false } */
async function deleteHandler(req, res) {
  const id = normalizeBeaconId(req.params.id);
  try {
    const result = await store.deleteBeacon(id);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * v1 resource API (canonical)
 *
 * POST   /v1/api/beacon/pixel           → register
 * GET    /v1/api/beacon/pixel/:id.gif   → pixel hit (public GIF)
 * GET    /v1/api/beacon/pixel/:id       → track (JSON)
 * PUT    /v1/api/beacon/pixel/:id       → reset count=0
 * DELETE /v1/api/beacon/pixel/:id       → delete
 *
 * Bare GET is track; use the .gif suffix for the open-tracking image so the
 * two never collide on the same path.
 */
app.post('/v1/api/beacon/pixel', requireApiKey, registerHandler);
app.get('/v1/api/beacon/pixel/:id', (req, res, next) => {
  if (/\.gif$/i.test(String(req.params.id || ''))) {
    return pixelHandler(req, res);
  }
  return requireApiKey(req, res, next);
}, trackHandler);
app.put('/v1/api/beacon/pixel/:id', requireApiKey, resetHandler);
app.delete('/v1/api/beacon/pixel/:id', requireApiKey, deleteHandler);

module.exports = app;

// Local / start:prod only — Hosting serves the SPA in Firebase prod.
if (require.main === module) {
  const buildDir = path.join(__dirname, '..', 'build');
  app.use(express.static(buildDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/v1/')) return next();
    res.sendFile(path.join(buildDir, 'index.html'), (err) => {
      if (err) res.status(404).json({ error: 'Not found' });
    });
  });

  app.listen(PORT, () => {
    console.log(`JobSimp site + beacon API on http://localhost:${PORT}`);
  });
}
