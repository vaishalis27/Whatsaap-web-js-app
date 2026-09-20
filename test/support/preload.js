// Loaded with `node --require` before server.js: swaps whatsapp-web.js for the mock and can simulate
// a broken pipe on SSE writes (what Node reports as an async 'error' event on the response).
const Module = require('module');
const http = require('http');
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === 'whatsapp-web.js') {
    return originalLoad.call(this, require.resolve('./mock-whatsapp-web'), parent, isMain);
  }
  return originalLoad.apply(this, arguments);
};

if (process.env.MOCK_EPIPE_MARKER) {
  const marker = process.env.MOCK_EPIPE_MARKER;
  const originalWrite = http.ServerResponse.prototype.write;
  http.ServerResponse.prototype.write = function (chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.includes(marker)) {
      // Real broken pipes surface asynchronously as an 'error' event, not as a throw from write()
      process.nextTick(() => this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
      return true;
    }
    return originalWrite.call(this, chunk, ...rest);
  };
}
