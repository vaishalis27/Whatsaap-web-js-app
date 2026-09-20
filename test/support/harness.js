// Starts the REAL server.js in a child process with the mocked WhatsApp client.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startServer({ env = {}, serverFile = process.env.TEST_SERVER_FILE || 'server.js' } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtas-test-'));
  const logFile = path.join(dir, 'mock.log');
  const controlFile = path.join(dir, 'control.json');
  fs.writeFileSync(logFile, '');

  const childEnv = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    // Keep the anti-detection pacing tiny so tests are fast
    MIN_MESSAGE_DELAY: '1',
    MAX_MESSAGE_DELAY: '2',
    COOLDOWN_PERIOD: '50',
    MAX_MESSAGES_BEFORE_COOLDOWN: '100000',
    MOCK_WA_LOG: logFile,
    MOCK_WA_CONTROL: controlFile,
    ...env
  };
  delete childEnv.API_KEY; // never inherit a developer's key
  if (env.API_KEY) childEnv.API_KEY = env.API_KEY;

  const child = spawn(
    process.execPath,
    ['--no-deprecation', '--require', path.join(ROOT, 'test', 'support', 'preload.js'), path.join(ROOT, serverFile)],
    { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const base = `http://127.0.0.1:${port}`;
  const server = {
    port, base, dir, logFile, controlFile, child,
    get output() { return output; },
    get exited() { return exited; },
    mockLog() {
      return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    },
    control(cmd) { fs.writeFileSync(controlFile, JSON.stringify(cmd)); },
    async request(pathname, { method = 'GET', headers = {}, json, body } = {}) {
      const init = { method, headers: { ...headers } };
      if (json !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(json);
      } else if (body !== undefined) {
        init.body = body;
      }
      const res = await fetch(base + pathname, init);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, data, text, headers: res.headers };
    },
    async waitFor(predicate, timeoutMs = 8000, label = 'condition') {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await sleep(50);
      }
      throw new Error(`Timed out waiting for ${label}\n--- server output ---\n${output}`);
    },
    async stop() {
      if (!exited) {
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
      }
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => { });
    }
  };

  await server.waitFor(async () => {
    if (exited) throw new Error('Server exited during startup:\n' + output);
    try {
      const r = await server.request('/api/health');
      return r.data && r.data.status === 'connected';
    } catch { return false; }
  }, 15000, 'server to become ready');
  return server;
}

module.exports = { startServer, sleep, ROOT };
