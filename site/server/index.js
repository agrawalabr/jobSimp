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

/** Optional gate for register / track / delete. Pixel stays public. */
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

/**
 * 1) Register a key
 * POST /api/beacon/register
 */
app.post('/api/beacon/register', requireApiKey, async (req, res) => {
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
});

/**
 * 2) Update by key (pixel download)
 * GET /api/beacon/pixel/:id.gif | /api/beacon/pixel/:id | /api/beacon/update/:id
 */
async function pixelHandler(req, res) {
  const id = String(req.params.id || '').replace(/\.gif$/i, '');
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

app.get('/api/beacon/pixel/:id', pixelHandler);
app.get('/api/beacon/update/:id', pixelHandler);

/**
 * 3) Track by key — return payload
 * GET /api/beacon/track/:id
 */
app.get('/api/beacon/track/:id', requireApiKey, async (req, res) => {
  try {
    const payload = await store.getBeacon(req.params.id);
    if (!payload) {
      res.status(404).json({ error: 'Beacon not found', id: req.params.id });
      return;
    }
    res.json(payload);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * 4) Delete / unregister a key (e.g. when outreach email is deleted)
 * DELETE /api/beacon/:id
 * DELETE /api/beacon/register/:id
 * Idempotent: { id, deleted: true|false }
 */
async function deleteHandler(req, res) {
  try {
    const result = await store.deleteBeacon(req.params.id);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
}

app.delete('/api/beacon/:id', requireApiKey, deleteHandler);
app.delete('/api/beacon/register/:id', requireApiKey, deleteHandler);

module.exports = app;

// Local / start:prod only — Hosting serves the SPA in Firebase prod.
if (require.main === module) {
  const buildDir = path.join(__dirname, '..', 'build');
  app.use(express.static(buildDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(buildDir, 'index.html'), (err) => {
      if (err) res.status(404).json({ error: 'Not found' });
    });
  });

  app.listen(PORT, () => {
    console.log(`JobSimp site + beacon API on http://localhost:${PORT}`);
  });
}
