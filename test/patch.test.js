// Verifies patches/whatsapp-web.js+1.34.2.patch (applied by `postinstall: patch-package`) fixes
// "Data passed to getter must include an id property" when sending to LID users.
//
// window.WWebJS.sendMessage builds the outgoing message key from getMaybeMePnUser(). On accounts where
// that returns undefined the key's `from` was undefined and WhatsApp Web's model getter threw.
// We run the real (patched) Utils.js against a fake `window.Store`, and the same source with the
// patch reverted in memory to show the difference.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const UTILS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
const PATCH = path.join(__dirname, '..', 'patches', 'whatsapp-web.js+1.34.2.patch');

const PATCHED_ME_USER =
  'const meUser = window.Store.User.getMaybeMePnUser() || window.Store.User.getMaybeMeUser?.() || window.Store.User.getMeUser?.() || lidUser;';
const ORIGINAL_ME_USER = 'const meUser = window.Store.User.getMaybeMePnUser();';

function loadSendMessage(source, userStore) {
  const keys = [];
  class MsgKey {
    constructor(opts) { keys.push(opts); this._serialized = 'key_serialized'; }
    static async newId() { return 'NEWID'; }
  }
  const window = {
    Store: {
      User: userStore,
      ChatGetters: { getIsNewsletter: () => false },
      MsgKey,
      WidFactory: { asUserWidOrThrow: (id) => { if (!id) throw new Error('Data passed to getter must include an id property'); return id; } },
      EphemeralFields: { getEphemeralFields: () => ({}) },
      SendMessage: { addAndSendMsgToChat: () => [Promise.resolve(), Promise.resolve()] },
      Msg: { get: () => ({ sent: true }) },
    },
  };
  const exportsObj = {};
  new Function('exports', 'window', source)(exportsObj, window);
  exportsObj.LoadUtils();
  return { sendMessage: window.WWebJS.sendMessage, keys };
}

const chatOf = ({ lid = false, group = false } = {}) => ({
  id: { isLid: () => lid, isGroup: () => group, _serialized: 'chat@x' },
  groupMetadata: { isLidAddressingMode: false },
});

const patchedSource = fs.readFileSync(UTILS, 'utf8');

test('the installed whatsapp-web.js contains the getMaybeMePnUser fallback (patch applied)', () => {
  assert.ok(patchedSource.includes(PATCHED_ME_USER), 'sendMessage falls back to getMaybeMeUser/getMeUser');
  assert.ok(patchedSource.includes('(window.Store.User.getMaybeMePnUser() || window.Store.User.getMaybeMeUser?.() || window.Store.User.getMeUser?.())._serialized'),
    'rejectCall has the same fallback');
  const patchFile = fs.readFileSync(PATCH, 'utf8');
  assert.ok(patchFile.includes('getMeUser?.()'), 'the fallback is recorded in the patch file (survives npm install)');
  // the earlier patches are still there
  assert.ok(patchFile.includes('getChatModel(chat).catch(() => null)'));
  assert.ok(patchFile.includes('NewsletterMetadataCollection?.update'));
});

test('WITHOUT the fix: account whose getMaybeMePnUser() is undefined produces an undefined `from` (the crash)', async () => {
  const unpatched = patchedSource.replace(PATCHED_ME_USER, ORIGINAL_ME_USER);
  assert.notEqual(unpatched, patchedSource, 'test setup: revert applied');
  const user = { getMaybeMeLidUser: () => 'ME_LID', getMaybeMePnUser: () => undefined, getMeUser: () => 'ME_PN' };

  const { sendMessage, keys } = loadSendMessage(unpatched, user);
  await sendMessage(chatOf({ lid: false }), 'hi');
  assert.equal(keys[0].from, undefined, 'undefined `from` is what WhatsApp Web rejects with "must include an id property"');

  const group = loadSendMessage(unpatched, user);
  await assert.rejects(group.sendMessage(chatOf({ group: true }), 'hi'), /must include an id property/);
});

test('WITH the fix: `from` falls back to getMeUser()/getMaybeMeUser()/the LID user', async () => {
  // getMaybeMePnUser undefined, getMeUser available
  let ctx = loadSendMessage(patchedSource, { getMaybeMeLidUser: () => 'ME_LID', getMaybeMePnUser: () => undefined, getMeUser: () => 'ME_PN' });
  await ctx.sendMessage(chatOf({ lid: false }), 'hi');
  assert.equal(ctx.keys[0].from, 'ME_PN');

  // getMaybeMeUser preferred over getMeUser
  ctx = loadSendMessage(patchedSource, { getMaybeMeLidUser: () => 'ME_LID', getMaybeMePnUser: () => undefined, getMaybeMeUser: () => 'ME_MAYBE', getMeUser: () => 'ME_PN' });
  await ctx.sendMessage(chatOf({ lid: false }), 'hi');
  assert.equal(ctx.keys[0].from, 'ME_MAYBE');

  // sending to a LID chat: still uses the LID identity
  ctx = loadSendMessage(patchedSource, { getMaybeMeLidUser: () => 'ME_LID', getMaybeMePnUser: () => undefined, getMeUser: () => 'ME_PN' });
  await ctx.sendMessage(chatOf({ lid: true }), 'hi');
  assert.equal(ctx.keys[0].from, 'ME_LID');

  // group chat no longer throws
  ctx = loadSendMessage(patchedSource, { getMaybeMeLidUser: () => 'ME_LID', getMaybeMePnUser: () => undefined, getMeUser: () => 'ME_PN' });
  await ctx.sendMessage(chatOf({ group: true }), 'hi');
  assert.equal(ctx.keys[0].participant, 'ME_PN');

  // last resort when neither legacy getter exists: the LID user (never undefined)
  ctx = loadSendMessage(patchedSource, { getMaybeMeLidUser: () => 'ME_LID', getMaybeMePnUser: () => undefined });
  await ctx.sendMessage(chatOf({ lid: false }), 'hi');
  assert.equal(ctx.keys[0].from, 'ME_LID');
});

test('WITH the fix: normal accounts are unaffected (getMaybeMePnUser still wins)', async () => {
  const ctx = loadSendMessage(patchedSource, { getMaybeMeLidUser: () => 'ME_LID', getMaybeMePnUser: () => 'ME_PN_REAL', getMeUser: () => 'SOMETHING_ELSE' });
  await ctx.sendMessage(chatOf({ lid: false }), 'hi');
  assert.equal(ctx.keys[0].from, 'ME_PN_REAL');
});

// ---------------------------------------------------------------------------------------------
// WhatsApp Web 2.3000.1047975898 removed two things the library relied on. The library then threw
// halfway through its startup: the phone showed "connected" but client.info / 'ready' never came.
//   1. window.require('WAWebSetPushnameConnAction') is undefined  -> ExposeStore threw on `.setPushname`
//   2. window.Store.Call no longer exists                          -> attachEventListeners threw on `.on`
// ---------------------------------------------------------------------------------------------
const STORE_JS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Store.js');
const CLIENT_JS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');

test('the installed library tolerates a missing WAWebSetPushnameConnAction module (patch applied)', () => {
  const store = fs.readFileSync(STORE_JS, 'utf8');
  assert.ok(store.includes("window.require('WAWebSetPushnameConnAction')?.setPushname"));
  assert.ok(!store.includes("window.require('WAWebSetPushnameConnAction').setPushname"));
  const patchFile = fs.readFileSync(PATCH, 'utf8');
  assert.ok(patchFile.includes("WAWebSetPushnameConnAction')?.setPushname"), 'recorded in the patch file (survives npm install)');
});

test('ExposeStore: WITHOUT the fix it throws on the missing module, WITH the fix it does not fail there', () => {
  const source = fs.readFileSync(STORE_JS, 'utf8');
  const run = (src) => {
    // window.require(name) -> harmless object for every module except the one WhatsApp removed
    const generic = () => new Proxy(function () { }, { get: (t, k) => (k === Symbol.toPrimitive ? undefined : generic()), apply: () => generic() });
    const window = { require: (name) => (name === 'WAWebSetPushnameConnAction' ? undefined : generic()), Debug: { VERSION: '2.3000.1047975898' } };
    const exportsObj = {};
    // WhatsApp Web also exposes its module loader as a bare global `require`
    new Function('exports', 'window', 'require', src)(exportsObj, window, window.require);
    exportsObj.ExposeStore();
    return window;
  };
  const unpatched = source.replace("window.require('WAWebSetPushnameConnAction')?.setPushname", "window.require('WAWebSetPushnameConnAction').setPushname");
  assert.notEqual(unpatched, source, 'test setup: revert applied');
  assert.throws(() => run(unpatched), /setPushname/);
  // the patched version gets past that line (any later, unrelated fake-module quirk must not mention setPushname)
  try { run(source); } catch (e) { assert.doesNotMatch(String(e.message), /setPushname/); }
});

test('the installed library tolerates a missing window.Store.Call (patch applied)', () => {
  const client = fs.readFileSync(CLIENT_JS, 'utf8');
  assert.ok(client.includes("window.Store.Call?.on('add'"));
  assert.ok(!client.includes("window.Store.Call.on('add'"));
  assert.ok(fs.readFileSync(PATCH, 'utf8').includes("Store.Call?.on('add'"));
});

test('attachEventListeners: WITHOUT the fix it throws when Store.Call is missing, WITH the fix it completes', async () => {
  const { Client } = (() => { const Module = require('module'); return { Client: require('whatsapp-web.js').Client }; })();
  const noop = () => { };
  const emitter = () => ({ on: noop, once: noop, off: noop });
  const makeWindow = () => ({
    onAddMessageEvent: noop, // bindings normally exposed by the library already exist
    compareWwebVersions: () => true,
    Debug: { VERSION: '2.3000.1047975898' },
    Store: { Msg: emitter(), Chat: emitter(), Conn: emitter(), AppState: emitter(), AddonPollVoteTable: emitter(), AddonReactionTable: emitter(), createOrUpdateReactionsModule: {}, MsgKey: function () { } /* Call intentionally absent */ },
  });
  const runWith = async (fnTransform) => {
    const window = makeWindow();
    const previous = global.window;
    global.window = window;
    const fake = {
      options: {}, emit: noop,
      pupPage: {
        // the library first checks/exposes its bindings, then evaluates the listener registration in the page
        evaluate: async (fn, ...args) => (args.length ? true : fnTransform(fn)()),
        exposeFunction: async () => { },
      },
    };
    try { await Client.prototype.attachEventListeners.call(fake); } finally { global.window = previous; }
  };
  // patched library (installed): no throw
  await runWith((fn) => fn);
  // same page function with the fix reverted -> the original crash
  await assert.rejects(runWith((fn) => new Function('return (' + fn.toString().replace('window.Store.Call?.on(', 'window.Store.Call.on(') + ')')()),
    /Cannot read properties of undefined \(reading 'on'\)/);
});
