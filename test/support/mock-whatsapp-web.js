// Minimal fake of whatsapp-web.js used by the integration tests (no Chrome needed).
//
// Behaviour is driven by env vars set by the test:
//   MOCK_WA_LOG      file the mock appends JSON lines to (initialize / destroy / send calls)
//   MOCK_WA_CONTROL  file polled for JSON commands: { emit: [event, ...args], clearInfo: bool }
//   MOCK_WA_NO_READY / MOCK_WA_NO_READY_AFTER_FIRST  never become ready (all clients / every client after the first)
//   MOCK_WA_LOCK     path (relative to the server's cwd) of a file to hold OPEN during destroy() (simulates Chrome's file lock)
const { EventEmitter } = require('events');
const fs = require('fs');

function log(entry) {
  if (!process.env.MOCK_WA_LOG) return;
  fs.appendFileSync(process.env.MOCK_WA_LOG, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
}

class LocalAuth {
  constructor(opts) { this.opts = opts; }
}

class MessageMedia {
  constructor(mimetype, data, filename) {
    this.mimetype = mimetype;
    this.data = data;
    this.filename = filename;
  }
  static fromFilePath(filePath) {
    // Same as the real implementation: synchronous read, so the file on disk is disposable afterwards
    const data = fs.readFileSync(filePath, { encoding: 'base64' });
    return new MessageMedia('image/png', data, require('path').basename(filePath));
  }
}

let current = null;
let poller = null;
let created = 0;

function startControlPoller() {
  if (poller || !process.env.MOCK_WA_CONTROL) return;
  poller = setInterval(() => {
    const file = process.env.MOCK_WA_CONTROL;
    if (!current || !fs.existsSync(file)) return;
    let cmd;
    try {
      cmd = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.unlinkSync(file);
    } catch {
      return;
    }
    if (cmd.clearInfo) current.info = null;
    if (cmd.emit) current.emit(...cmd.emit);
  }, 50);
}

class Client extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.info = null;
    this.destroyed = false;
    this.ordinal = ++created;
    current = this;
    log({ ev: 'new-client' });
    startControlPoller();
  }

  async initialize() {
    log({ ev: 'initialize' });
    if (process.env.MOCK_WA_NO_READY) return;
    if (process.env.MOCK_WA_NO_READY_AFTER_FIRST && this.ordinal > 1) return;
    setTimeout(() => {
      if (this.destroyed) return;
      this.info = { wid: { user: '911234567890' }, pushname: 'Mock' };
      this.emit('ready');
    }, 50);
  }

  async destroy() {
    log({ ev: 'destroy:start' });
    this.destroyed = true;
    this.info = null;
    let handle = null;
    const lockPath = process.env.MOCK_WA_LOCK && require('path').resolve(process.cwd(), process.env.MOCK_WA_LOCK);
    if (lockPath && fs.existsSync(lockPath)) {
      // Holding a handle open inside the session folder makes rm fail with EBUSY/EPERM on Windows
      handle = fs.openSync(lockPath, 'r');
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    if (handle !== null) fs.closeSync(handle);
    log({ ev: 'destroy:end' });
  }

  async logout() { log({ ev: 'logout' }); }

  async sendMessage(to, content, options) {
    const payload = typeof content === 'string'
      ? { text: content }
      : { media: { mimetype: content.mimetype, data: content.data, filename: content.filename, caption: content.caption } };
    log({ ev: 'send', to, ...payload });
    if (String(to).includes('broken')) {
      throw new Error('Session closed. Most likely the page has been closed.');
    }
    if (String(to).includes('ghost')) return undefined; // library returns nothing when it cannot resolve the chat
    return { id: { _serialized: `true_${to}_MOCKID` }, timestamp: 1700000000 };
  }

  async getChatById(id) {
    return { isGroup: String(id).endsWith('@g.us'), name: 'Mock Chat' };
  }

  async getChats() {
    return [];
  }
}

module.exports = { Client, LocalAuth, MessageMedia };
