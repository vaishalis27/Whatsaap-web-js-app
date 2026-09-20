// Pure helpers for server.js (no WhatsApp/Puppeteer dependencies, so they can be unit tested).
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .doc, .docx
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xls, .xlsx
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .ppt, .pptx
  'text/plain',
  'video/mp4', 'video/quicktime', 'video/x-msvideo', // .mp4, .mov, .avi
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg'
];

// Sanitize filename to prevent path traversal attacks
function sanitizeFilename(filename) {
  // Remove path traversal attempts
  let sanitized = String(filename).replace(/\.\./g, '').replace(/[\/\\]/g, '_');
  // Remove any non-alphanumeric characters except dots, hyphens, underscores
  sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Limit length
  if (sanitized.length > 255) {
    const ext = path.extname(sanitized);
    sanitized = sanitized.substring(0, 255 - ext.length) + ext;
  }
  return sanitized;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'string') return '';
  // Trim and limit length (WhatsApp has a 4096 character limit)
  return message.trim().substring(0, 4096);
}

/**
 * Normalize a group id. Accepts `123-456@g.us` or a bare `123-456` / `120363...` id.
 * Returns the normalized id, or null when it cannot be a group id.
 */
function normalizeGroupId(groupId) {
  if (!groupId || typeof groupId !== 'string') return null;
  const trimmed = groupId.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (trimmed.includes('@')) {
    return trimmed.endsWith('@g.us') && trimmed.length > 6 ? trimmed : null;
  }
  // Bare group id: "<creator>-<timestamp>" (legacy) or a long numeric id (new format)
  return /^\d{5,}(-\d+)?$/.test(trimmed) ? `${trimmed}@g.us` : null;
}

/**
 * Normalize a contact id. Accepts `number@c.us`, `id@lid` (WhatsApp linked identity),
 * or a raw phone number (digits, optionally with +, spaces, dashes or brackets).
 * Returns the normalized id, or null when it cannot be a contact id.
 */
function normalizeContactId(contactId) {
  if (!contactId || typeof contactId !== 'string') return null;
  const trimmed = contactId.trim();
  if (!trimmed) return null;
  if (trimmed.includes('@')) {
    if (/\s/.test(trimmed)) return null;
    const ok = (trimmed.endsWith('@c.us') || trimmed.endsWith('@lid')) && trimmed.length > 6;
    return ok ? trimmed : null;
  }
  const digits = trimmed.replace(/[\s\-().+]/g, '');
  // E.164 allows at most 15 digits; anything shorter than 7 is not a real number
  return /^\d{7,15}$/.test(digits) ? `${digits}@c.us` : null;
}

function validateGroupId(groupId) {
  return normalizeGroupId(groupId) !== null;
}

function validateContactId(contactId) {
  return normalizeContactId(contactId) !== null;
}

const DATA_URL_REGEX = /^data:([a-zA-Z0-9]+\/[a-zA-Z0-9.+-]+)(?:;[a-zA-Z0-9=._-]+)*;base64,(.*)$/s;
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parse a base64 media payload. Accepts raw base64 or a `data:<mime>;base64,<data>` URL.
 * The data URL prefix is stripped so MessageMedia never receives it (that corrupts the file).
 * Returns { data, mimetype } (mimetype only set when it came from a data URL) or null when invalid.
 */
function parseBase64Media(media) {
  if (!media || typeof media !== 'string') return null;
  let mimetype = null;
  let data = media.trim();
  const match = DATA_URL_REGEX.exec(data);
  if (match) {
    mimetype = match[1];
    data = match[2];
  }
  data = data.replace(/\s+/g, '');
  if (!data || !BASE64_REGEX.test(data)) return null;
  return { data, mimetype };
}

function validateBase64Media(media) {
  return parseBase64Media(media) !== null;
}

/**
 * Request timeout middleware factory. Must be registered BEFORE the routes to have any effect.
 * `longPaths` get `longMs` (e.g. message sends that legitimately wait in the anti-detection queue);
 * `skipPaths` (e.g. the long-lived SSE stream) are exempt.
 */
function createRequestTimeout({ ms = 60000, longMs = 300000, longPaths = [], skipPaths = [] } = {}) {
  return (req, res, next) => {
    const pathname = (req.originalUrl || req.url || '').split('?')[0];
    if (skipPaths.includes(pathname)) {
      // Keep-alive sockets remember the timeout of the previous request; clear it for long-lived streams
      res.setTimeout(0);
      return next();
    }
    const timeout = longPaths.includes(pathname) ? longMs : ms;
    // Must be res.setTimeout, not req.setTimeout: Node only emits 'timeout' on the request while its body
    // is still incoming (!req.complete). For a fully-read request it emits on the response, and with no
    // listener there it just destroys the socket (client sees "socket hang up" instead of a 408).
    res.setTimeout(timeout, () => {
      if (!res.headersSent) {
        res.status(408).json({ ok: false, error: 'Request timeout' });
      }
    });
    next();
  };
}

/** Constant-time comparison of the X-API-Key header against the configured key. */
function isValidApiKey(providedKey, configuredKey) {
  if (!configuredKey || typeof providedKey !== 'string' || !providedKey) return false;
  const a = crypto.createHash('sha256').update(providedKey).digest();
  const b = crypto.createHash('sha256').update(String(configuredKey)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Parse the TRUST_PROXY env value: number of hops ("1"), "true"/"false", or a subnet/keyword list. */
function parseTrustProxy(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  if (v.toLowerCase() === 'true') return true;
  if (v.toLowerCase() === 'false') return false;
  return v;
}

/**
 * Remove ONLY the LocalAuth session folder of this client (`session-<clientId>`), never the whole
 * `.wwebjs_auth` directory. Retries on EBUSY/EPERM (Chrome may still be releasing file locks on Windows).
 */
async function clearAuthSession(clientId, authRoot = path.resolve(process.cwd(), '.wwebjs_auth')) {
  const sessionPath = path.join(authRoot, `session-${clientId}`);
  try {
    await fs.rm(sessionPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
    return true;
  } catch (err) {
    console.error('Error clearing auth session:', err);
    return false;
  }
}

/** Delete files in `dir` older than `maxAgeMs` (orphans left by dropped connections/crashes). */
async function sweepOldFiles(dir, maxAgeMs) {
  let removed = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === '.gitkeep') continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.unlink(full);
        removed++;
      }
    } catch {
      // File vanished or is locked; ignore
    }
  }
  return removed;
}

module.exports = {
  ALLOWED_MIME_TYPES,
  sanitizeFilename,
  sanitizeMessage,
  normalizeGroupId,
  normalizeContactId,
  validateGroupId,
  validateContactId,
  parseBase64Media,
  validateBase64Media,
  createRequestTimeout,
  isValidApiKey,
  parseTrustProxy,
  clearAuthSession,
  sweepOldFiles
};
