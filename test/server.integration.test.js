// Runs the REAL server.js in a child process with a mocked whatsapp-web.js (no Chrome / WhatsApp needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { startServer, sleep, ROOT } = require('./support/harness');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const UPLOADS = path.join(ROOT, 'uploads');

const sends = (server) => server.mockLog().filter(e => e.ev === 'send');
const count = (server, ev) => server.mockLog().filter(e => e.ev === ev).length;

function uploadsSnapshot() {
  try { return new Set(fs.readdirSync(UPLOADS)); } catch { return new Set(); }
}

test('send-contact: normalizes ids, returns id AND messageId, accepts @lid', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  // Raw phone number (was rejected before) -> normalized to @c.us
  let r = await server.request('/send-contact', { method: 'POST', json: { contactId: '+91 98765-43210', message: 'hi' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.id, 'true_919876543210@c.us_MOCKID');
  assert.equal(r.data.messageId, r.data.id, 'both id and messageId are returned');

  // Linked identity id (was rejected before)
  r = await server.request('/send-contact', { method: 'POST', json: { contactId: '123456789012345@lid', message: 'hello lid' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.messageId, 'true_123456789012345@lid_MOCKID');

  // Plain @c.us keeps working
  r = await server.request('/send-contact', { method: 'POST', json: { contactId: '919876543210@c.us', message: 'plain' } });
  assert.equal(r.status, 200, r.text);

  assert.deepEqual(sends(server).map(s => s.to),
    ['919876543210@c.us', '123456789012345@lid', '919876543210@c.us']);

  // Garbage is still rejected with a helpful 400
  for (const bad of ['abc', '123', 'x@g.us']) {
    r = await server.request('/send-contact', { method: 'POST', json: { contactId: bad, message: 'x' } });
    assert.equal(r.status, 400, `contactId ${bad}`);
    assert.match(r.data.error, /Invalid contactId/);
  }
  r = await server.request('/send-contact', { method: 'POST', json: { message: 'x' } });
  assert.equal(r.status, 400);
  r = await server.request('/send-contact', { method: 'POST', json: { contactId: '919876543210@c.us' } });
  assert.equal(r.status, 400, 'message or file is required');
});

test('send-group: normalizes ids and returns id AND messageId', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  let r = await server.request('/send-group', { method: 'POST', json: { groupId: '120363012345678901@g.us', message: 'hi group' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.id, 'true_120363012345678901@g.us_MOCKID');
  assert.equal(r.data.messageId, r.data.id);
  assert.equal(r.data.groupName, 'Mock Chat');

  r = await server.request('/send-group', { method: 'POST', json: { groupId: '919876543210-1600000000', message: 'bare id' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(sends(server)[1].to, '919876543210-1600000000@g.us');

  r = await server.request('/send-group', { method: 'POST', json: { groupId: '919876543210@c.us', message: 'wrong kind' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Invalid groupId/);
});

test('base64 media: data URL prefix is stripped before MessageMedia is built', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  // data URL, mimetype taken from the URL
  let r = await server.request('/send-contact', {
    method: 'POST',
    json: { contactId: '919876543210@c.us', message: 'pic', media: `data:image/png;base64,${PNG_B64}`, filename: 'a b.png' }
  });
  assert.equal(r.status, 200, r.text);
  let media = sends(server)[0].media;
  assert.equal(media.data, PNG_B64, 'no "data:...;base64," prefix may reach MessageMedia');
  assert.equal(media.mimetype, 'image/png');
  assert.equal(media.filename, 'a_b.png');
  assert.equal(media.caption, 'pic');

  // raw base64 + explicit mimetype (PDF): unchanged behaviour
  const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
  r = await server.request('/send-group', {
    method: 'POST',
    json: { groupId: '120363012345678901@g.us', media: pdf, mimetype: 'application/pdf', filename: 'x.pdf' }
  });
  assert.equal(r.status, 200, r.text);
  media = sends(server)[1].media;
  assert.equal(media.data, pdf);
  assert.equal(media.mimetype, 'application/pdf');

  // explicit mimetype wins over the data URL one
  r = await server.request('/send-contact', {
    method: 'POST',
    json: { contactId: '919876543210@c.us', media: `data:application/octet-stream;base64,${pdf}`, mimetype: 'application/pdf' }
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(sends(server)[2].media.mimetype, 'application/pdf');

  // invalid payloads / mimetypes
  r = await server.request('/send-contact', { method: 'POST', json: { contactId: '919876543210@c.us', media: '%%%not-base64%%%' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Invalid base64/);
  r = await server.request('/send-contact', { method: 'POST', json: { contactId: '919876543210@c.us', media: `data:application/x-msdownload;base64,${pdf}` } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Invalid mimetype/);
  assert.equal(sends(server).length, 3, 'rejected requests never reach WhatsApp');
});

test('uploads: files are deleted on success AND on early rejection (no orphans in uploads/)', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const before = uploadsSnapshot();

  const png = Buffer.from(PNG_B64, 'base64');
  const form = (contactId) => {
    const f = new FormData();
    f.append('contactId', contactId);
    f.append('message', 'with file');
    f.append('file', new Blob([png], { type: 'image/png' }), 'slip.png');
    return f;
  };

  // success
  let r = await server.request('/send-contact', { method: 'POST', body: form('919876543210@c.us') });
  assert.equal(r.status, 200, r.text);
  assert.equal(sends(server)[0].media.data, PNG_B64, 'file content was sent');

  // rejected by validation AFTER multer saved the file (this used to leak the file)
  r = await server.request('/send-contact', { method: 'POST', body: form('not-a-contact') });
  assert.equal(r.status, 400);

  // rejected because WhatsApp is not ready is covered by the same close handler; give 'close' handlers a tick
  await server.waitFor(() => {
    const now = uploadsSnapshot();
    return [...now].every(f => before.has(f));
  }, 5000, 'uploads/ to be free of new files');
  const leaked = [...uploadsSnapshot()].filter(f => !before.has(f));
  assert.deepEqual(leaked, []);
});

test('rate limiting: unauthenticated callers are limited per IP; trust proxy separates real client IPs', async (t) => {
  const server = await startServer({ env: { TRUST_PROXY: '1' } });
  t.after(() => server.stop());

  const send = (ip) => server.request('/send-contact', {
    method: 'POST',
    headers: { 'X-Forwarded-For': ip },
    json: { contactId: '919876543210@c.us', message: 'burst ' + Math.random() }
  });

  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await send('10.0.0.1')).status);
  assert.equal(statuses.filter(s => s === 200).length, 10);
  assert.equal(statuses.filter(s => s === 429).length, 2);

  // A different client behind the same proxy is NOT throttled (per-client keys work with trust proxy)
  assert.equal((await send('10.0.0.2')).status, 200);
  assert.doesNotMatch(server.output, /ERR_ERL/, 'express-rate-limit must not complain about the proxy setup');
});

test('rate limiting: a valid API_KEY bypasses the limiter (bulk/cron sends), a wrong key does not', async (t) => {
  const server = await startServer({ env: { API_KEY: 'topsecret', TRUST_PROXY: '' } });
  t.after(() => server.stop());

  const send = (key) => server.request('/send-contact', {
    method: 'POST',
    headers: { 'X-API-Key': key },
    json: { contactId: '919876543210@c.us', message: 'bulk ' + Math.random() }
  });

  const okStatuses = [];
  for (let i = 0; i < 15; i++) okStatuses.push((await send('topsecret')).status);
  assert.deepEqual([...new Set(okStatuses)], [200], 'no 429 for a trusted caller');

  assert.equal((await send('wrong')).status, 403);
  assert.equal((await server.request('/send-contact', { method: 'POST', json: { contactId: '919876543210@c.us', message: 'x' } })).status, 401);
});

test('API key: dashboard paths incl. /api/reset-list work without a key; sends do not', async (t) => {
  const server = await startServer({ env: { API_KEY: 'topsecret' } });
  t.after(() => server.stop());

  let r = await server.request('/api/reset-list', { method: 'POST' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.ok, true);

  r = await server.request('/list-groups');
  assert.equal(r.status, 200);
  r = await server.request('/send-group', { method: 'POST', json: { groupId: '1-2@g.us', message: 'x' } });
  assert.equal(r.status, 401);
});

test('SSE: a broken pipe on a listener does not crash the server', async (t) => {
  const server = await startServer({ env: { MOCK_EPIPE_MARKER: '"authFailure":true' } });
  t.after(() => server.stop());

  // Open the SSE stream and keep the connection open
  const socket = net.connect(server.port, '127.0.0.1');
  t.after(() => socket.destroy());
  socket.on('error', () => { /* the server closes the dead stream; a reset here is expected */ });
  let received = '';
  socket.on('data', d => { received += d; });
  socket.write('GET /api/qr-stream HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n');
  await server.waitFor(() => received.includes('"connected":true'), 5000, 'initial SSE event');

  // Server writes to the listener; the preload turns that write into an async EPIPE 'error' on the response
  server.control({ emit: ['auth_failure', 'boom'] });
  await server.waitFor(() => /Auth failure/.test(server.output), 5000, 'auth_failure to be processed');
  await sleep(300);

  assert.equal(server.exited, false, 'server must survive:\n' + server.output);
  assert.doesNotMatch(server.output, /Uncaught Exception/);
  const health = await server.request('/api/health');
  assert.equal(health.data.status, 'connected');
});

test('LOGGED_OUT does not auto-reconnect; NAVIGATION still does', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  assert.equal(count(server, 'initialize'), 1);

  // Listen to the SSE stream to see the loggedOut notification
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(server.base + '/api/qr-stream', { signal: controller.signal });
  const reader = res.body.getReader();
  let sse = '';
  (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; sse += Buffer.from(value).toString(); } } catch { /* aborted */ } })();

  server.control({ clearInfo: true, emit: ['disconnected', 'LOGGED_OUT'] });
  await server.waitFor(() => /"loggedOut":true/.test(sse), 5000, 'loggedOut SSE event');
  await sleep(4500); // longer than the 3s reconnect delay used for other reasons
  assert.equal(count(server, 'initialize'), 1, 'must NOT reinitialize after LOGGED_OUT');
  assert.equal(count(server, 'destroy:start'), 0);

  // Manual re-link still works after LOGGED_OUT
  const r = await server.request('/api/force-qr', { method: 'POST' });
  assert.equal(r.status, 200, r.text);
  await server.waitFor(() => count(server, 'initialize') === 2, 5000, 'force-qr initialize');
});

test('NAVIGATION disconnect still auto-reconnects (after destroying the old client)', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  server.control({ clearInfo: true, emit: ['disconnected', 'NAVIGATION'] });
  await server.waitFor(() => count(server, 'initialize') === 2, 9000, 'reinitialize after NAVIGATION');

  const log = server.mockLog().map(e => e.ev);
  assert.ok(log.indexOf('destroy:end') < log.lastIndexOf('initialize'), 'old client fully destroyed before the new one starts: ' + log.join(','));
  await server.waitFor(async () => (await server.request('/api/health')).data.status === 'connected', 5000, 'reconnected');
});

test('force-qr: awaits destroy() before deleting the session, and deletes ONLY this instance session', async (t) => {
  const server = await startServer({ env: { MOCK_WA_LOCK: '.wwebjs_auth/session-my-instance/Default/LOCK' } });
  t.after(() => server.stop());

  const authRoot = path.join(server.dir, '.wwebjs_auth');
  const mine = path.join(authRoot, 'session-my-instance');
  const other = path.join(authRoot, 'session-another-instance');
  fs.mkdirSync(path.join(mine, 'Default'), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  // While destroy() runs the mock holds this file open, like Chrome does (rm => EBUSY/EPERM on Windows)
  fs.writeFileSync(path.join(mine, 'Default', 'LOCK'), 'lock');
  fs.writeFileSync(path.join(other, 'keep.txt'), 'keep');

  const r = await server.request('/api/force-qr', { method: 'POST' });
  assert.equal(r.status, 200, r.text + '\n' + server.output);
  assert.equal(r.data.ok, true);

  assert.equal(fs.existsSync(mine), false, 'own session folder removed');
  assert.equal(fs.existsSync(path.join(other, 'keep.txt')), true, 'other sessions untouched');
  assert.equal(fs.existsSync(authRoot), true, '.wwebjs_auth root untouched');
  assert.doesNotMatch(server.output, /Error clearing auth session/);

  const log = server.mockLog().map(e => e.ev);
  assert.ok(log.indexOf('destroy:end') !== -1 && log.indexOf('destroy:end') < log.lastIndexOf('initialize'),
    'old client destroyed (awaited) before the new client starts: ' + log.join(','));
  await server.waitFor(async () => (await server.request('/api/health')).data.status === 'connected', 5000, 'new client ready');
});

test('force-qr twice in a row: second call is rejected while the first is in progress', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const [a, b] = await Promise.all([
    server.request('/api/force-qr', { method: 'POST' }),
    server.request('/api/force-qr', { method: 'POST' })
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 400]);
  await server.waitFor(async () => (await server.request('/api/health')).data.status === 'connected', 5000, 'ready again');
  assert.equal(count(server, 'initialize'), 2, 'exactly one new client was created');
});

test('a broken WhatsApp page (Session closed) returns 503 reconnecting and recovers', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  let r = await server.request('/send-contact', { method: 'POST', json: { contactId: 'broken@lid', message: 'x' } });
  assert.equal(r.status, 503);
  assert.equal(r.data.reconnecting, true);
  await server.waitFor(() => count(server, 'initialize') === 2, 5000, 'reinitialize after broken session');
  await server.waitFor(async () => (await server.request('/api/health')).data.status === 'connected', 5000, 'recovered');

  r = await server.request('/send-contact', { method: 'POST', json: { contactId: '919876543210@c.us', message: 'after recovery' } });
  assert.equal(r.status, 200, r.text);
});

test('queued messages wait for a reconnect instead of all failing', async (t) => {
  // Pacing of ~1.5s per message so message B is still queued when the session drops
  const server = await startServer({ env: { MIN_MESSAGE_DELAY: '1500', MAX_MESSAGE_DELAY: '1500', COOLDOWN_PERIOD: '50' } });
  t.after(() => server.stop());

  const send = (n) => server.request('/send-contact', { method: 'POST', json: { contactId: '919876543210@c.us', message: 'queued ' + n } });
  const a = send('A');
  await server.waitFor(() => sends(server).length === 1, 5000, 'first send');
  const b = send('B');                      // waits behind the anti-detection delay
  await sleep(200);
  server.control({ clearInfo: true, emit: ['disconnected', 'NAVIGATION'] }); // session drops while B is queued

  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200, ra.text);
  assert.equal(rb.status, 200, 'B survives the reconnect: ' + rb.text + '\n' + server.output);
  assert.equal(sends(server).length, 2);
  assert.equal(count(server, 'initialize'), 2, 'the client was reinitialized in between');
});

test('queued messages fail cleanly (CLIENT_NOT_READY) when the session never comes back', async (t) => {
  const server = await startServer({
    env: { MIN_MESSAGE_DELAY: '1200', MAX_MESSAGE_DELAY: '1200', QUEUE_READY_TIMEOUT_MS: '1500', MOCK_WA_NO_READY_AFTER_FIRST: '1' }
  });
  t.after(() => server.stop());

  const send = (n) => server.request('/send-contact', { method: 'POST', json: { contactId: '919876543210@c.us', message: 'q ' + n } });
  const a = send('A');
  await server.waitFor(() => sends(server).length === 1, 5000, 'first send');
  const b = send('B');
  await sleep(200);
  server.control({ clearInfo: true, emit: ['disconnected', 'CONFLICT'] });

  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 500);
  assert.match(rb.data.error, /not ready/i);

  // The queue is not wedged: /status still answers and reports it idle
  const status = await server.request('/status');
  assert.equal(status.data.antiDetection.queueLength, 0);
  assert.equal(status.data.antiDetection.isProcessing, false);
});

test('library returning no message gives a clear error instead of a TypeError about undefined', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const r = await server.request('/send-contact', { method: 'POST', json: { contactId: 'ghost@lid', message: 'x' } });
  assert.equal(r.status, 500);
  assert.match(r.data.error, /did not confirm the message/);
  assert.doesNotMatch(r.data.error, /Cannot read properties/);

  // the service keeps working afterwards
  const ok = await server.request('/send-contact', { method: 'POST', json: { contactId: '919876543210@c.us', message: 'still fine' } });
  assert.equal(ok.status, 200, ok.text);
});
