const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const h = require('../lib/helpers');

test('normalizeContactId: accepts @c.us, @lid and raw phone numbers', () => {
  assert.equal(h.normalizeContactId('919876543210@c.us'), '919876543210@c.us');
  assert.equal(h.normalizeContactId('  919876543210@c.us  '), '919876543210@c.us');
  assert.equal(h.normalizeContactId('123456789012345@lid'), '123456789012345@lid');
  assert.equal(h.normalizeContactId('919876543210'), '919876543210@c.us');
  assert.equal(h.normalizeContactId('+91 98765-43210'), '919876543210@c.us');
  assert.equal(h.normalizeContactId('(91) 98765 43210'), '919876543210@c.us');
});

test('normalizeContactId: rejects things that are not contacts', () => {
  for (const bad of ['', '   ', null, undefined, 42, 'abc', '12345', '1234567890123456', 'x@g.us', '123-456@g.us',
    '9198@c.us'.replace('9198', ''), 'a b@c.us', '919876543210@s.whatsapp.net', '@lid']) {
    assert.equal(h.normalizeContactId(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('normalizeGroupId: accepts @g.us and bare ids, rejects contacts', () => {
  assert.equal(h.normalizeGroupId('120363012345678901@g.us'), '120363012345678901@g.us');
  assert.equal(h.normalizeGroupId('919876543210-1600000000@g.us'), '919876543210-1600000000@g.us');
  assert.equal(h.normalizeGroupId('919876543210-1600000000'), '919876543210-1600000000@g.us');
  assert.equal(h.normalizeGroupId('120363012345678901'), '120363012345678901@g.us');
  for (const bad of ['', null, undefined, 'abc', '919876543210@c.us', '123@lid', 'a b@g.us', '@g.us', '12']) {
    assert.equal(h.normalizeGroupId(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('validateContactId / validateGroupId are boolean wrappers', () => {
  assert.equal(h.validateContactId('919876543210'), true);
  assert.equal(h.validateContactId('nope'), false);
  assert.equal(h.validateGroupId('1-2@g.us'.replace('1-2', '12345-678')), true);
  assert.equal(h.validateGroupId('nope'), false);
});

test('parseBase64Media: strips the data URL prefix (no duplication into MessageMedia)', () => {
  const raw = Buffer.from('hello world').toString('base64');
  assert.deepEqual(h.parseBase64Media(raw), { data: raw, mimetype: null });
  assert.deepEqual(h.parseBase64Media(`data:image/png;base64,${raw}`), { data: raw, mimetype: 'image/png' });
  assert.deepEqual(h.parseBase64Media(`data:application/pdf;base64,${raw}`), { data: raw, mimetype: 'application/pdf' });
  // extra data URL parameters and stray whitespace/newlines (MIME-style wrapped base64)
  assert.deepEqual(h.parseBase64Media(`data:image/jpeg;charset=utf-8;base64,${raw.slice(0, 4)}\n${raw.slice(4)}`),
    { data: raw, mimetype: 'image/jpeg' });
  // The prefix must never survive
  assert.ok(!h.parseBase64Media(`data:image/png;base64,${raw}`).data.includes('data:'));
});

test('parseBase64Media: rejects invalid payloads', () => {
  for (const bad of ['', null, undefined, 5, 'not base64!', 'data:image/png;base64,', 'data:image/png,abc', 'abc=def', '====']) {
    assert.equal(h.parseBase64Media(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(h.validateBase64Media('aGVsbG8='), true);
  assert.equal(h.validateBase64Media('$$$'), false);
});

test('sanitizeFilename / sanitizeMessage', () => {
  assert.equal(h.sanitizeFilename('../../etc/passwd'), '__etc_passwd');
  assert.equal(h.sanitizeFilename('my file (1).pdf'), 'my_file__1_.pdf');
  assert.ok(h.sanitizeFilename('a'.repeat(400) + '.png').length <= 255);
  assert.equal(h.sanitizeMessage('  hi  '), 'hi');
  assert.equal(h.sanitizeMessage(undefined), '');
  assert.equal(h.sanitizeMessage('x'.repeat(5000)).length, 4096);
});

test('isValidApiKey is strict and handles missing values', () => {
  assert.equal(h.isValidApiKey('secret', 'secret'), true);
  assert.equal(h.isValidApiKey('secre', 'secret'), false);
  assert.equal(h.isValidApiKey('', 'secret'), false);
  assert.equal(h.isValidApiKey(undefined, 'secret'), false);
  assert.equal(h.isValidApiKey(['secret'], 'secret'), false);
  assert.equal(h.isValidApiKey('anything', undefined), false); // no key configured => nobody is "trusted"
  assert.equal(h.isValidApiKey('', ''), false);
});

test('parseTrustProxy', () => {
  assert.equal(h.parseTrustProxy(undefined, 1), 1);
  assert.equal(h.parseTrustProxy('', false), false);
  assert.equal(h.parseTrustProxy('2', 1), 2);
  assert.equal(h.parseTrustProxy('true', 1), true);
  assert.equal(h.parseTrustProxy('false', 1), false);
  assert.equal(h.parseTrustProxy('loopback', 1), 'loopback');
});

test('clearAuthSession removes only this instance\'s session-* folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtas-auth-'));
  try {
    fs.mkdirSync(path.join(root, 'session-my-instance', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(root, 'session-my-instance', 'Default', 'x'), '1');
    fs.mkdirSync(path.join(root, 'session-other'), { recursive: true });
    fs.writeFileSync(path.join(root, 'session-other', 'y'), '2');

    assert.equal(await h.clearAuthSession('my-instance', root), true);
    assert.equal(fs.existsSync(path.join(root, 'session-my-instance')), false);
    assert.equal(fs.existsSync(path.join(root, 'session-other', 'y')), true, 'other sessions must survive');
    assert.equal(fs.existsSync(root), true, 'the .wwebjs_auth root must survive');

    // Already-missing session is not an error
    assert.equal(await h.clearAuthSession('my-instance', root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweepOldFiles removes only files older than the max age', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtas-sweep-'));
  try {
    const oldFile = path.join(dir, 'old.png');
    const newFile = path.join(dir, 'new.png');
    const keep = path.join(dir, '.gitkeep');
    for (const f of [oldFile, newFile, keep]) fs.writeFileSync(f, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);
    fs.utimesSync(keep, twoHoursAgo, twoHoursAgo);

    assert.equal(await h.sweepOldFiles(dir, 60 * 60 * 1000), 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(newFile), true);
    assert.equal(fs.existsSync(keep), true);
    assert.equal(await h.sweepOldFiles(path.join(dir, 'missing'), 1), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- request timeout: proves ordering matters (the original bug registered it AFTER the routes)
function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function get(server, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path: pathname, agent: false }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('client gave up')); });
  });
}

test('createRequestTimeout answers 408 when registered BEFORE routes', async () => {
  const app = express();
  app.use(h.createRequestTimeout({ ms: 150 }));
  app.get('/hang', () => { /* never responds */ });
  const server = await listen(app);
  try {
    const r = await get(server, '/hang');
    assert.equal(r.status, 408);
    assert.match(r.body, /Request timeout/);
  } finally {
    server.close();
  }
});

test('createRequestTimeout registered AFTER routes never runs (documents the original bug)', async () => {
  const app = express();
  app.get('/hang', () => { /* never responds */ });
  app.use(h.createRequestTimeout({ ms: 150 }));
  const server = await listen(app);
  try {
    await assert.rejects(get(server, '/hang'), /client gave up/);
  } finally {
    server.close();
  }
});

test('createRequestTimeout: skipPaths are exempt and longPaths get the longer window', async () => {
  const app = express();
  app.use(h.createRequestTimeout({ ms: 100, longMs: 100000, longPaths: ['/slow'], skipPaths: ['/stream'] }));
  app.get('/slow', (req, res) => setTimeout(() => res.json({ ok: true }), 400));
  app.get('/stream', (req, res) => setTimeout(() => res.json({ ok: true }), 400));
  // A late handler must not write after the 408 already went out
  app.get('/normal', (req, res) => setTimeout(() => { if (!res.headersSent) res.json({ ok: true }); }, 400));
  const server = await listen(app);
  try {
    assert.equal((await get(server, '/slow')).status, 200);
    assert.equal((await get(server, '/stream')).status, 200);
    assert.equal((await get(server, '/normal')).status, 408);
  } finally {
    server.close();
  }
});

test('server.js registers the timeout middleware before any route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const timeoutAt = src.indexOf('app.use(createRequestTimeout(');
  const firstRoute = src.search(/app\.(get|post)\(/);
  assert.ok(timeoutAt > 0, 'timeout middleware is registered');
  assert.ok(timeoutAt < firstRoute, 'timeout middleware comes before the first route');
  assert.ok(!/req\.setTimeout\(60000/.test(src), 'old post-route timeout middleware is gone');
});

// ---- middleware.js
function runAuth(reqOverrides, apiKey) {
  const prev = process.env.API_KEY;
  if (apiKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = apiKey;
  delete require.cache[require.resolve('../middleware')];
  const { apiKeyAuth } = require('../middleware');
  return new Promise(resolve => {
    const headers = { host: 'example.com', ...(reqOverrides.headers || {}) };
    const req = {
      originalUrl: reqOverrides.url,
      url: reqOverrides.url,
      headers,
      get: (name) => headers[name.toLowerCase()]
    };
    const res = {
      status(code) { this.code = code; return this; },
      json(body) { resolve({ code: this.code, body }); }
    };
    apiKeyAuth(req, res, () => resolve({ code: 200, passed: true }));
  }).finally(() => {
    if (prev === undefined) delete process.env.API_KEY; else process.env.API_KEY = prev;
  });
}

test('apiKeyAuth: /api/reset-list is a dashboard path (no 401 when Referer/Origin are stripped)', async () => {
  const r = await runAuth({ url: '/api/reset-list' }, 'secret');
  assert.equal(r.passed, true);
});

test('apiKeyAuth: sending endpoints still require the key', async () => {
  assert.equal((await runAuth({ url: '/send-contact' }, 'secret')).code, 401);
  assert.equal((await runAuth({ url: '/send-contact', headers: { 'x-api-key': 'wrong' } }, 'secret')).code, 403);
  assert.equal((await runAuth({ url: '/send-contact', headers: { 'x-api-key': 'secret' } }, 'secret')).passed, true);
  assert.equal((await runAuth({ url: '/send-contact' }, undefined)).passed, true, 'no API_KEY configured => open');
});
