const cors = require('cors');
const express = require('express');
const path = require('path');
const c = require('./controller');

const PORT = Number(process.env.PORT) || 8787;
const API_KEY = process.env.BEACON_API_KEY || '';

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const header = req.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : '';
  const key = bearer || req.get('x-beacon-key') || '';
  if (key !== API_KEY) return c.fail(res, 401, 'Unauthorized');
  next();
}

const run = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => c.fail(res, e.status || 500, e.message || 'Server error'));

app.post('/v1/api/beacon/pixel', requireApiKey, run(c.create));
app.get('/v1/api/beacon/pixel/:id', (req, res) => {
  if (/\.gif$/i.test(String(req.params.id || ''))) return c.pixel(req, res);
  return c.fail(res, 404, 'Not found');
});
app.get('/v1/api/beacon/pixels', requireApiKey, run(c.list));
app.put('/v1/api/beacon/pixel/:id', requireApiKey, run(c.reset));
app.delete('/v1/api/beacon/pixels', requireApiKey, run(c.destroy));

app.use('/v1/api/beacon', (req, res) => c.fail(res, 404, 'Not found'));

module.exports = app;

if (require.main === module) {
  const buildDir = path.join(__dirname, '..', 'build');
  app.use(express.static(buildDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/v1/')) return next();
    res.sendFile(path.join(buildDir, 'index.html'), (err) => {
      if (err) c.fail(res, 404, 'Not found');
    });
  });
  app.listen(PORT, () => {
    console.log(`JobSimp site + beacon API on http://localhost:${PORT}`);
  });
}
