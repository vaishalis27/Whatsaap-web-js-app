// server.js - v1.0.1 (Fixed MessageMedia incompatibility)
require('dotenv').config();
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cors = require('cors');
const {
  ALLOWED_MIME_TYPES,
  sanitizeFilename,
  sanitizeMessage,
  normalizeGroupId,
  normalizeContactId,
  parseBase64Media,
  createRequestTimeout,
  isValidApiKey,
  parseTrustProxy,
  clearAuthSession: clearAuthSessionFolder,
  sweepOldFiles
} = require('./lib/helpers');

const app = express();

// Behind a reverse proxy (nginx/Hostinger) every client would otherwise share the proxy's IP,
// which breaks per-IP rate limiting. Default: trust 1 hop in production, none otherwise
// (trusting X-Forwarded-For without a proxy lets clients spoof their IP). Override with TRUST_PROXY.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV === 'production' ? 1 : false));

// Request timeout must be registered BEFORE the routes (Express runs middleware in order, so a
// timeout registered after the routes never runs). The SSE stream is exempt (long-lived) and the
// send endpoints get a longer window because they can legitimately wait in the anti-detection queue.
app.use(createRequestTimeout({
  ms: parseInt(process.env.REQUEST_TIMEOUT_MS) || 60000,
  longMs: parseInt(process.env.SEND_REQUEST_TIMEOUT_MS) || 5 * 60 * 1000,
  longPaths: ['/send-group', '/send-contact'],
  skipPaths: ['/api/qr-stream']
}));

// Security: Helmet.js for security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Allow inline scripts and eval (needed for some libraries)
      scriptSrcAttr: ["'unsafe-inline'"], // Allow inline event handlers (onclick, etc.)
      imgSrc: ["'self'", "data:", "blob:"], // Allow data URLs and blob URLs for images
      fontSrc: ["'self'", "data:"], // Allow fonts from self and data URLs
      connectSrc: ["'self'"], // Allow fetch/XHR to same origin
      frameSrc: ["'none'"], // Disable iframes
      objectSrc: ["'none'"], // Disable plugins
      baseUri: ["'self'"], // Restrict base tag
      formAction: ["'self'"] // Restrict form submissions
    },
    reportOnly: false // Enforce CSP (not just report)
  },
  crossOriginEmbedderPolicy: false, // Allow SSE connections
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow cross-origin resources
  upgradeInsecureRequests: process.env.NODE_ENV === 'production' // Upgrade HTTP to HTTPS in production (boolean, not a directive)
}));

// CORS configuration (restrict in production)
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Compression for better performance.
// Never compress the SSE stream: gzip buffers small writes, so clients that send Accept-Encoding: gzip
// (all browsers) would not receive QR/status events until the buffer fills.
app.use(compression({
  filter: (req, res) => {
    const contentType = String(res.getHeader('Content-Type') || '');
    if (contentType.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));

// Request size limits (prevent DoS)
app.use(express.json({ limit: '10mb' })); // Limit JSON payloads
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Limit form data

// Rate limiting to prevent abuse
// Trusted server-to-server callers (bulk/cron notifications) present a valid X-API-Key and are exempt:
// pacing is enforced by the anti-detection queue instead, so limiting them only causes HTTP 429s.
const hasValidApiKey = (req) => isValidApiKey(req.headers['x-api-key'], process.env.API_KEY);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { ok: false, error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (hasValidApiKey(req)) return true;
    // Don't count QR/connection endpoints (qr-image auto-refreshes every 3s)
    const pathname = (req.originalUrl || req.url || '').split('?')[0];
    return pathname === '/api/qr' || pathname === '/api/qr-image' || pathname === '/api/qr-stream' ||
      pathname === '/api/health';
  },
});

// Stricter rate limiting for message sending endpoints (more conservative to avoid detection)
const sendMessageLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // Reduced to 10 messages per minute per IP (more conservative)
  message: { ok: false, error: 'Too many messages sent. Please wait a moment to avoid detection.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: hasValidApiKey,
});

app.use('/api/', limiter); // Apply to all API routes
app.use('/send-group', sendMessageLimiter);
app.use('/send-contact', sendMessageLimiter);



// Configure multer for file uploads with security
const uploadDir = path.join(__dirname, 'uploads');
// Ensure uploads directory exists
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const sanitized = sanitizeFilename(file.originalname || 'file');
    cb(null, uniqueSuffix + '-' + sanitized);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 1 // Only one file at a time
  },
  fileFilter: (req, file, cb) => {
    // Security: Validate file type
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`), false);
    }
  }
});

// Middleware to handle both JSON and multipart/form-data
const handleFileUpload = (req, res, next) => {
  // If content-type is application/json, skip multer
  if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
    return next();
  }
  // Otherwise use multer for multipart/form-data
  return upload.single('file')(req, res, (err) => {
    if (err) {
      // Handle multer errors
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            ok: false,
            error: 'File too large. Maximum size is 100MB.'
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({
            ok: false,
            error: 'Too many files. Only one file allowed.'
          });
        }
        return res.status(400).json({
          ok: false,
          error: `Upload error: ${err.message}`
        });
      }
      // Handle file filter errors
      if (err.message && err.message.includes('File type not allowed')) {
        return res.status(400).json({
          ok: false,
          error: err.message
        });
      }
      return res.status(400).json({
        ok: false,
        error: 'File upload error'
      });
    }
    // The upload is read into memory (MessageMedia.fromFilePath) as soon as the handler starts, so the
    // file on disk is disposable once the response is done. 'close' fires on every exit path
    // (success, validation error, thrown error, dropped connection), so nothing is orphaned in uploads/.
    if (req.file && req.file.path) {
      const uploadedPath = req.file.path;
      res.once('close', () => {
        fs.unlink(uploadedPath).catch((e) => {
          if (e.code !== 'ENOENT') console.error('Failed to delete upload:', e.message);
        });
      });
    }
    next();
  });
};

// Sweep orphaned uploads (e.g. left by a crash) at startup and hourly
const UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;
const sweepUploads = () => sweepOldFiles(uploadDir, UPLOAD_MAX_AGE_MS)
  .then(n => { if (n) console.log(`Removed ${n} orphaned upload(s)`); })
  .catch(() => { });
sweepUploads();
setInterval(sweepUploads, 60 * 60 * 1000).unref();

// Store current QR code data
let currentQRCode = null;
const qrCodeListeners = new Set(); // Use Set for better performance
let isLoggingOut = false; // Flag to prevent concurrent logout operations
let isClientDestroyed = false; // Flag to track if client is being destroyed
let lastNotReadyLog = 0; // Throttle "client not ready" logs
let lastProtocolErrorLog = 0; // Throttle ProtocolError logs

// ============================================
// ANTI-DETECTION SYSTEM (Prevent WhatsApp logout)
// ============================================

// Configuration for anti-detection (can be adjusted via environment variables)
const ANTI_DETECTION_CONFIG = {
  // Minimum delay between messages (milliseconds)
  minDelay: parseInt(process.env.MIN_MESSAGE_DELAY) || 2000, // 2 seconds default
  // Maximum delay between messages (milliseconds) - adds randomness
  maxDelay: parseInt(process.env.MAX_MESSAGE_DELAY) || 5000, // 5 seconds default
  // Cooldown period after sending multiple messages (milliseconds)
  cooldownPeriod: parseInt(process.env.COOLDOWN_PERIOD) || 30000, // 30 seconds
  // Maximum messages before cooldown
  maxMessagesBeforeCooldown: parseInt(process.env.MAX_MESSAGES_BEFORE_COOLDOWN) || 5,
  // Additional delay for media files (they take longer to process)
  mediaDelayMultiplier: parseFloat(process.env.MEDIA_DELAY_MULTIPLIER) || 1.5
};

// Message queue to prevent rapid-fire sending
const messageQueue = [];
let isProcessingQueue = false;
let lastMessageTime = 0;
let messageCountInWindow = 0;
let cooldownUntil = 0;

// Message history tracking (to detect patterns)
const messageHistory = [];
const MAX_HISTORY_SIZE = 50; // Keep last 50 messages

// Generate human-like random delay
function getHumanDelay(hasMedia = false) {
  const baseDelay = ANTI_DETECTION_CONFIG.minDelay +
    Math.random() * (ANTI_DETECTION_CONFIG.maxDelay - ANTI_DETECTION_CONFIG.minDelay);

  // Add extra delay for media files
  const delay = hasMedia
    ? baseDelay * ANTI_DETECTION_CONFIG.mediaDelayMultiplier
    : baseDelay;

  // Round to nearest 100ms for more natural timing
  return Math.round(delay / 100) * 100;
}

// Check if we need to wait (cooldown or rate limiting)
function shouldWait() {
  const now = Date.now();

  // Check cooldown period
  if (now < cooldownUntil) {
    return cooldownUntil - now;
  }

  // Check if we've sent too many messages recently
  if (messageCountInWindow >= ANTI_DETECTION_CONFIG.maxMessagesBeforeCooldown) {
    cooldownUntil = now + ANTI_DETECTION_CONFIG.cooldownPeriod;
    messageCountInWindow = 0;
    return ANTI_DETECTION_CONFIG.cooldownPeriod;
  }

  // Check minimum delay since last message
  const timeSinceLastMessage = now - lastMessageTime;
  const requiredDelay = getHumanDelay();

  if (timeSinceLastMessage < requiredDelay) {
    return requiredDelay - timeSinceLastMessage;
  }

  return 0;
}

// Add message to history
function addToHistory(recipientId, message, hasMedia) {
  messageHistory.push({
    recipientId,
    message: message.substring(0, 50), // Store first 50 chars for pattern detection
    hasMedia,
    timestamp: Date.now()
  });

  // Keep history size manageable
  if (messageHistory.length > MAX_HISTORY_SIZE) {
    messageHistory.shift();
  }
}

// Check for suspicious patterns (identical messages sent rapidly)
function detectSuspiciousPattern(recipientId, message) {
  const recentMessages = messageHistory
    .filter(m => Date.now() - m.timestamp < 60000) // Last minute
    .filter(m => m.message === message.substring(0, 50));

  // If same message sent 3+ times in last minute, it's suspicious
  if (recentMessages.length >= 3) {
    return true;
  }

  // Check for rapid sending to same recipient
  const sameRecipient = messageHistory
    .filter(m => Date.now() - m.timestamp < 10000) // Last 10 seconds
    .filter(m => m.recipientId === recipientId);

  if (sameRecipient.length >= 3) {
    return true;
  }

  return false;
}

// Is the WhatsApp client connected and usable right now?
function isClientReady() {
  return !!(client && client.info && !isClientDestroyed && !isLoggingOut);
}

// When the session drops (reconnect, QR re-link) queued messages should wait for it to come back
// instead of all failing at once. Resolves true when ready, false if it did not recover in time.
const QUEUE_READY_TIMEOUT_MS = parseInt(process.env.QUEUE_READY_TIMEOUT_MS) || 45000;
async function waitForClientReady(timeoutMs = QUEUE_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!isClientReady()) {
    // A logout in progress will not recover on its own; fail fast
    if (isLoggingOut || Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return true;
}

// Process message queue
async function processMessageQueue() {
  if (isProcessingQueue || messageQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  try {
    while (messageQueue.length > 0) {
      const queueItem = messageQueue[0];

      // Check if we need to wait
      const waitTime = shouldWait();
      if (waitTime > 0) {
        console.log(`⏳ Anti-detection: Waiting ${Math.round(waitTime / 1000)}s before sending next message...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      // Check for suspicious patterns
      if (detectSuspiciousPattern(queueItem.recipientId, queueItem.message || '')) {
        console.warn('⚠️  Suspicious pattern detected! Adding extra delay...');
        await new Promise(resolve => setTimeout(resolve, ANTI_DETECTION_CONFIG.cooldownPeriod));
      }

      // If the session dropped while queued, give it a chance to reconnect before failing this message
      if (!isClientReady()) {
        console.log('⏳ Queue: WhatsApp client not ready, waiting for reconnect...');
        const recovered = await waitForClientReady();
        if (!recovered) {
          messageQueue.shift();
          const notReady = new Error('WhatsApp client not ready (session did not reconnect in time)');
          notReady.code = 'CLIENT_NOT_READY';
          if (queueItem.reject) queueItem.reject(notReady);
          continue;
        }
      }

      // Remove from queue
      messageQueue.shift();

      // Execute the send function
      try {
        const delay = getHumanDelay(queueItem.hasMedia);
        if (delay > 0 && lastMessageTime > 0) {
          // Only add delay if we've sent a message before
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        await queueItem.sendFunction();

        // Update tracking
        lastMessageTime = Date.now();
        messageCountInWindow++;
        addToHistory(queueItem.recipientId, queueItem.message || '', queueItem.hasMedia);

        // Resolve the promise
        if (queueItem.resolve) {
          queueItem.resolve();
        }

        // Reset message count after cooldown period
        setTimeout(() => {
          messageCountInWindow = Math.max(0, messageCountInWindow - 1);
        }, ANTI_DETECTION_CONFIG.cooldownPeriod).unref();

      } catch (error) {
        console.error('Error processing queued message:', error);
        if (queueItem.reject) {
          queueItem.reject(error);
        }
      }
    }
  } finally {
    // Never leave the queue stuck in "processing" if something unexpected throws
    isProcessingQueue = false;
  }
}

// Queue a message for sending (with anti-detection)
function queueMessage(recipientId, message, hasMedia, sendFunction) {
  return new Promise((resolve, reject) => {
    messageQueue.push({
      recipientId,
      message,
      hasMedia,
      sendFunction,
      resolve,
      reject
    });

    // Start processing queue if not already processing
    processMessageQueue().catch(console.error);
  });
}

// Serve static files (dashboard) with caching
app.use(express.static('public', {
  maxAge: '1d', // Cache static files for 1 day
  etag: true,
  lastModified: true
}));

// API key authentication (required when API_KEY is set in .env)
const { apiKeyAuth } = require('./middleware');
app.use(apiKeyAuth);

// Client configuration
const AUTH_CLIENT_ID = 'my-instance'; // LocalAuth stores this client in .wwebjs_auth/session-<AUTH_CLIENT_ID>
const clientConfig = {
  authStrategy: new LocalAuth({ clientId: AUTH_CLIENT_ID }),
  // Use 'local' cache - 'none' can fetch versions WhatsApp rejects for linking
  webVersionCache: { type: 'local' },
  // Modern Chrome user agent (helps avoid "could not link device" in some cases)
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  puppeteer: {
    headless: true,
    protocolTimeout: 120000,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer'
    ]
  }
};

// Create client instance
let client = new Client(clientConfig);

// Setup client event handlers
function setupClientEvents() {
  // Events from a client that has since been replaced/destroyed must not touch the current state
  const self = client;
  const isStale = () => self !== client;
  client.on('authenticated', () => { });
  client.on('qr', async (qr) => {
    if (isStale()) return;
    console.log('--- Scan this QR with your WhatsApp phone ---');
    console.log('Web view: http://localhost:' + (process.env.PORT || 4000) + '/api/qr-image');
    qrcode.generate(qr, { small: true });

    // Generate QR code as data URL for web dashboard
    try {
      currentQRCode = await QRCode.toDataURL(qr, {
        width: 400,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });

      // Notify all SSE listeners (with error handling)
      notifyQRListeners({ qr: currentQRCode, hasQR: true });
    } catch (err) {
      console.error('Error generating QR code image:', err);
    }
  });

  client.on('ready', () => {
    if (isStale()) return;
    console.log('WhatsApp client ready.');
    // Clear QR code when connected
    currentQRCode = null;
    // Reset flags when client is ready
    isClientDestroyed = false;
    isLoggingOut = false;
    notifyQRListeners({ qr: null, hasQR: false, connected: true });
  });

  client.on('auth_failure', msg => {
    if (isStale()) return;
    console.error('Auth failure:', msg);
    notifyQRListeners({ qr: null, hasQR: false, connected: false, authFailure: true });
  });

  client.on('disconnected', (reason) => {
    if (isStale()) return;
    console.log('Client disconnected:', reason);
    currentQRCode = null;
    // Reset flags if disconnected (not during logout)
    if (!isLoggingOut) {
      isClientDestroyed = false;
    }
    // LOGGED_OUT means the user unlinked this device from their phone. Reconnecting cannot work
    // (the session is revoked) and would just loop, so report it and wait for a manual re-link
    // (POST /api/force-qr or the dashboard's "New QR" button).
    if (reason === 'LOGGED_OUT') {
      console.log('Device was logged out from the phone. Not reconnecting automatically; scan a new QR to re-link.');
      notifyQRListeners({ qr: null, hasQR: false, connected: false, loggedOut: true });
      return;
    }
    notifyQRListeners({ qr: null, hasQR: false, connected: false });

    // Auto-reconnect if session was closed unexpectedly (not during logout)
    if (!isLoggingOut && (reason === 'NAVIGATION' || reason === 'CONFLICT')) {
      console.log('Session closed unexpectedly. Attempting to reinitialize...');
      setTimeout(() => {
        if (!isLoggingOut && !isClientDestroyed) {
          reinitializeClient();
        }
      }, 3000); // Wait 3 seconds before reconnecting
    }
  });

  client.on('message', msg => {
    // Optional: log incoming messages for debugging
    // console.log('Message received:', msg.from, msg.body);
  });
}

// Setup initial client events
setupClientEvents();

// Helper function to notify all QR code listeners with error handling
function notifyQRListeners(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  const deadListeners = [];

  qrCodeListeners.forEach(res => {
    try {
      res.write(message);
    } catch (err) {
      // Connection is dead, mark for removal
      deadListeners.push(res);
    }
  });

  // Remove dead listeners
  deadListeners.forEach(listener => qrCodeListeners.delete(listener));
}

// Helper function to clear THIS instance's auth session only (never other sessions in .wwebjs_auth)
async function clearAuthSession() {
  const cleared = await clearAuthSessionFolder(AUTH_CLIENT_ID);
  if (cleared) console.log('Auth session cleared');
  return cleared;
}

// Destroy a client and WAIT for Chrome to exit; otherwise it keeps file locks on the session folder
// (EBUSY/EPERM on Windows when the folder is deleted right after).
async function destroyClientSafely(target, label) {
  if (!target) return;
  try {
    await Promise.race([
      target.destroy(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('destroy timeout')), 15000).unref())
    ]);
  } catch (err) {
    console.warn(`Error destroying client (${label}):`, err.message);
  }
}

// Start a client without letting an initialization failure become an unhandled rejection
function initializeClient(target) {
  Promise.resolve(target.initialize()).catch(err => {
    console.error('Client initialization failed:', err && err.message ? err.message : err);
  });
}

let isReinitializing = false; // Guards against concurrent reinit (watchdog + request errors + disconnect handler)

// Helper function to reinitialize client when session is closed
async function reinitializeClient() {
  if (isLoggingOut || isClientDestroyed || isReinitializing) {
    console.log('Skipping reinitialize - logout in progress, client destroyed, or reinit already running');
    return;
  }

  isReinitializing = true;
  try {
    console.log('Reinitializing WhatsApp client...');
    isClientDestroyed = true; // Prevent new requests during reinit

    // Destroy existing client (and wait for the browser to exit) before creating a new one
    const oldClient = client;
    await destroyClientSafely(oldClient, 'reinit');

    // Create new client instance
    client = new Client(clientConfig);
    setupClientEvents();
    initializeClient(client);

    console.log('Client reinitialization started. Waiting for QR code or connection...');
  } catch (err) {
    console.error('Error reinitializing client:', err);
  } finally {
    // A fresh client without a session is not "destroyed": /api/force-qr must stay usable while a QR is pending.
    // Requests are still rejected by the client.info check until it is ready.
    isClientDestroyed = false;
    isReinitializing = false;
  }
}

// Detect errors that mean the page's injected WhatsApp Web script context is broken
// (WA Web silently reloaded/updated and wiped window.WWebJS/window.Store, or the
// Puppeteer page/session died) rather than a normal, user-actionable send failure.
// client.info can still be truthy in this state, so requests keep failing until we reinit.
function isSessionBrokenError(err) {
  const msg = err && err.message ? String(err.message) : '';
  return (
    msg.includes('Session closed') ||
    msg.includes('Protocol error') ||
    msg.includes('Execution context was destroyed') ||
    msg.includes('Target closed') ||
    (msg.includes('Cannot read properties of undefined') && (msg.includes('getChat') || msg.includes('WWebJS')))
  );
}

/**
 * Force a fresh QR by clearing saved session and reinitializing (use when stuck "restoring" or QR never appears)
 */
async function forceNewQR() {
  if (isLoggingOut || isClientDestroyed || isReinitializing) {
    console.log('Skipping forceNewQR - logout in progress or client destroyed');
    return { ok: false, error: 'Please wait, operation in progress.' };
  }
  isReinitializing = true;
  try {
    console.log('Force new QR: clearing session and reinitializing...');
    isClientDestroyed = true;
    currentQRCode = null;
    notifyQRListeners({ qr: null, hasQR: false, connected: false });

    // Wait for Chrome to exit BEFORE deleting its profile folder (file locks -> EBUSY/EPERM on Windows)
    const oldClient = client;
    client = null;
    await destroyClientSafely(oldClient, 'force-qr');

    const cleared = await clearAuthSession();
    if (!cleared) {
      // Do not leave the service without a client: bring the previous session back
      client = new Client(clientConfig);
      setupClientEvents();
      initializeClient(client);
      return { ok: false, error: 'Failed to clear session folder.' };
    }

    // New client with fresh auth (no saved session = will emit QR)
    client = new Client(clientConfig);
    setupClientEvents();
    initializeClient(client);
    console.log('Client reinitialized. QR code should appear shortly.');
    return { ok: true, message: 'Session cleared. QR code will appear in 15–60 seconds.' };
  } catch (err) {
    console.error('Error in forceNewQR:', err);
    if (!client) {
      client = new Client(clientConfig);
      setupClientEvents();
      initializeClient(client);
    }
    return { ok: false, error: err.message || 'Failed to force new QR.' };
  } finally {
    isClientDestroyed = false;
    isReinitializing = false;
  }
}

initializeClient(client);

// Watchdog: periodically verify the page's injected WWebJS/Store scripts are still
// present. WA Web can silently reload its page (version bump, long idle, etc.)
// without emitting a 'disconnected' event, which leaves client.info truthy while
// every send/list call fails with "Cannot read properties of undefined (reading
// 'getChat')". Catching that proactively avoids surfacing it to slip-sending users.
setInterval(async () => {
  if (isClientDestroyed || isLoggingOut || !client || !client.info || !client.pupPage) {
    return;
  }
  try {
    const healthy = await Promise.race([
      client.pupPage.evaluate(() => !!(window.WWebJS && window.Store)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('watchdog timeout')), 15000))
    ]);
    if (!healthy) {
      console.warn('Watchdog: window.WWebJS/window.Store missing while client reports ready. Reinitializing...');
      reinitializeClient();
    }
  } catch (err) {
    console.warn('Watchdog check failed, reinitializing:', err.message);
    reinitializeClient();
  }
}, 5 * 60 * 1000);

/**
 * Health check endpoint (API)
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'WhatsApp API is running',
    status: (client && client.info) ? 'connected' : 'connecting'
  });
});

/**
 * List groups (to find a group's id)
 * GET /list-groups
 */
app.get('/list-groups', async (req, res) => {
  try {
    // Check if client is being destroyed or logged out
    if (isClientDestroyed || isLoggingOut) {
      console.log('Groups request blocked: isClientDestroyed=', isClientDestroyed, 'isLoggingOut=', isLoggingOut);
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp client is being reset. Please wait...'
      });
    }

    // More thorough client state check
    if (!client) {
      if (Date.now() - lastNotReadyLog > 60000) {
        lastNotReadyLog = Date.now();
        console.log(currentQRCode ? 'Scan QR code at /api/qr-image' : 'Restoring session... Please wait.');
      }
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp client not initialized. Please wait...'
      });
    }

    if (!client.info) {
      if (Date.now() - lastNotReadyLog > 60000) {
        lastNotReadyLog = Date.now();
        console.log(currentQRCode ? 'Scan QR code at /api/qr-image' : 'Restoring session... Please wait.');
      }
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp client not ready yet. Please wait for connection...'
      });
    }

    // Try to get chats with timeout
    let chats;
    try {
      chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout getting chats')), 30000)
        )
      ]);
    } catch (chatError) {
      console.error('Error getting chats:', chatError);
      if (isSessionBrokenError(chatError)) {
        // Attempt to reinitialize if session is closed
        if (!isLoggingOut && !isClientDestroyed) {
          console.log('Session broken detected. Attempting to reinitialize...');
          reinitializeClient();
        }
        return res.status(503).json({
          ok: false,
          error: 'WhatsApp session closed. Reconnecting automatically. Please wait a moment and try again.',
          reconnecting: true
        });
      }
      throw chatError;
    }

    // Filter and validate groups
    const groups = [];
    for (const chat of chats) {
      if (chat.isGroup) {
        try {
          // Validate group still exists by checking if we can access it
          const groupId = chat.id._serialized;
          if (groupId && groupId.endsWith('@g.us')) {
            groups.push({
              id: groupId,
              name: chat.name || 'Unnamed Group',
              participants: chat.participants?.length || null
            });
          }
        } catch (err) {
          // Skip invalid groups
          console.log(`Skipping invalid group: ${chat.id?._serialized || 'unknown'}`);
        }
      }
    }

    res.json({ ok: true, groups, count: groups.length });
  } catch (err) {
    console.error('Error listing groups:', err);
    // Check if error is due to session being closed
    if (isSessionBrokenError(err)) {
      // Attempt to reinitialize if session is closed
      if (!isLoggingOut && !isClientDestroyed) {
        console.log('Session broken detected in error handler. Attempting to reinitialize...');
        reinitializeClient();
      }
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp session error. Reconnecting automatically. Please wait a moment and try again.',
        reconnecting: true
      });
    }
    // Security: Don't expose stack traces in production
    const errorMessage = process.env.NODE_ENV === 'development'
      ? err.message || 'Failed to list groups'
      : 'Failed to list groups';

    res.status(500).json({
      ok: false,
      error: errorMessage,
      ...(process.env.NODE_ENV === 'development' && { details: err.stack })
    });
  }
});

/**
 * List contacts (personal chats, not groups)
 * GET /list-contacts
 */
app.get('/list-contacts', async (req, res) => {
  try {
    // Check if client is being destroyed or logged out
    if (isClientDestroyed || isLoggingOut) {
      console.log('Contacts request blocked: isClientDestroyed=', isClientDestroyed, 'isLoggingOut=', isLoggingOut);
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp client is being reset. Please wait...'
      });
    }

    // More thorough client state check
    if (!client) {
      if (Date.now() - lastNotReadyLog > 60000) {
        lastNotReadyLog = Date.now();
        console.log(currentQRCode ? 'Scan QR code at /api/qr-image' : 'Restoring session... Please wait.');
      }
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp client not initialized. Please wait...'
      });
    }

    if (!client.info) {
      if (Date.now() - lastNotReadyLog > 60000) {
        lastNotReadyLog = Date.now();
        console.log(currentQRCode ? 'Scan QR code at /api/qr-image' : 'Restoring session... Please wait.');
      }
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp client not ready yet. Please wait for connection...'
      });
    }

    // Try to get chats with timeout
    let chats;
    try {
      chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout getting chats')), 30000)
        )
      ]);
    } catch (chatError) {
      console.error('Error getting chats:', chatError);
      if (isSessionBrokenError(chatError)) {
        // Attempt to reinitialize if session is closed
        if (!isLoggingOut && !isClientDestroyed) {
          console.log('Session broken detected. Attempting to reinitialize...');
          reinitializeClient();
        }
        return res.status(503).json({
          ok: false,
          error: 'WhatsApp session closed. Reconnecting automatically. Please wait a moment and try again.',
          reconnecting: true
        });
      }
      throw chatError;
    }

    // Filter contacts: exclude groups and "Note to Self" (isMe)
    // Also ensure the chat ID ends with @c.us (personal contact format)
    const contacts = [];
    const nonGroupChats = chats.filter(c => !c.isGroup);

    console.log(`[Contacts] Total chats: ${chats.length}, Non-group chats: ${nonGroupChats.length}`);

    for (const chat of chats) {
      try {
        // Must not be a group
        if (chat.isGroup) continue;

        // Exclude "Note to Self" / "Saved Messages" chat
        if (chat.isMe) {
          console.log(`[Contacts] Skipping "Note to Self" chat: ${chat.id?._serialized || 'unknown'}`);
          continue;
        }

        // Get chat ID
        const chatId = chat.id?._serialized || '';
        if (!chatId) {
          console.log(`[Contacts] Skipping chat with no ID:`, chat);
          continue;
        }

        // Check if it's a personal contact (ends with @c.us)
        // Also accept chats that might not have the @c.us format but are not groups
        if (!chatId.endsWith('@c.us') && !chatId.includes('@')) {
          console.log(`[Contacts] Skipping chat with unexpected ID format: ${chatId}`);
          continue;
        }

        // If it doesn't end with @c.us, check if it's a valid contact format
        if (!chatId.endsWith('@c.us')) {
          // Some contacts might have different formats, let's be more lenient
          // But still skip if it looks like a group ID
          if (chatId.endsWith('@g.us') || chatId.endsWith('@broadcast')) {
            continue;
          }
          // Accept other formats that might be contacts
          console.log(`[Contacts] Accepting contact with non-standard ID format: ${chatId}`);
        }

        const userId = chat.id?.user || chatId.split('@')[0] || null;
        const contactName = chat.name || userId || 'Unknown';

        contacts.push({
          id: chatId,
          name: contactName,
          number: userId || null
        });

        console.log(`[Contacts] Added contact: ${contactName} (${chatId})`);
      } catch (err) {
        console.error(`[Contacts] Error processing chat:`, err, chat);
      }
    }

    // Enhanced debug logging
    console.log(`[Contacts] Final result: ${contacts.length} contacts found`);
    if (contacts.length === 0 && nonGroupChats.length > 0) {
      console.log(`[Contacts] No contacts found but ${nonGroupChats.length} non-group chats exist. Details:`);
      nonGroupChats.slice(0, 10).forEach(c => {
        const chatId = c.id?._serialized || 'no-id';
        console.log(`  - ID: ${chatId}, isMe: ${c.isMe}, isGroup: ${c.isGroup}, name: "${c.name || 'no-name'}"`);
      });
    }

    res.json({ ok: true, contacts, count: contacts.length });
  } catch (err) {
    console.error('Error listing contacts:', err);
    // Check if error is due to session being closed
    if (isSessionBrokenError(err)) {
      // Attempt to reinitialize if session is closed
      if (!isLoggingOut && !isClientDestroyed) {
        console.log('Session broken detected in error handler. Attempting to reinitialize...');
        reinitializeClient();
      }
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp session error. Reconnecting automatically. Please wait a moment and try again.',
        reconnecting: true
      });
    }
    // Security: Don't expose stack traces in production
    const errorMessage = process.env.NODE_ENV === 'development'
      ? err.message || 'Failed to list contacts'
      : 'Failed to list contacts';

    res.status(500).json({
      ok: false,
      error: errorMessage,
      ...(process.env.NODE_ENV === 'development' && { details: err.stack })
    });
  }
});

/**
 * Send message to group (with optional media)
 * POST /send-group
 * body: { "groupId": "123456789-123@g.us", "message": "Hello group!", "media": "base64string" (optional), "mimetype": "image/jpeg" (optional), "filename": "image.jpg" (optional) }
 * OR multipart/form-data with file field
 */
app.post('/send-group', handleFileUpload, async (req, res) => {
  // Handle multer errors gracefully
  if (req.fileValidationError) {
    return res.status(400).json({
      ok: false,
      error: req.fileValidationError
    });
  }

  try {
    // Quick validation checks first
    if (isClientDestroyed || isLoggingOut) {
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp client is being reset. Please wait...'
      });
    }

    if (!client || !client.info) {
      return res.status(503).json({ ok: false, error: 'WhatsApp client not ready yet' });
    }

    // Get and validate form data
    const rawGroupId = req.body.groupId ? String(req.body.groupId).trim() : '';
    let message = req.body.message ? String(req.body.message) : '';
    const media = req.body.media ? String(req.body.media) : null;
    const mimetype = req.body.mimetype ? String(req.body.mimetype).trim() : null;
    const filename = req.body.filename ? String(req.body.filename).trim() : null;

    // Validate groupId format (a bare "123-456" is accepted and normalized to "123-456@g.us")
    if (!rawGroupId) {
      return res.status(400).json({
        ok: false,
        error: 'groupId is required'
      });
    }

    const groupId = normalizeGroupId(rawGroupId);
    if (!groupId) {
      // Log the actual value for debugging (only in development)
      if (process.env.NODE_ENV === 'development') {
        console.log('Invalid groupId received:', JSON.stringify(rawGroupId));
      }
      return res.status(400).json({
        ok: false,
        error: `Invalid groupId format. Received: "${rawGroupId.substring(0, 50)}". Expected format: numbers-numbers@g.us (e.g., 123456789-123456789@g.us)`
      });
    }

    // Sanitize message
    message = sanitizeMessage(message);

    // Prepare message/media in parallel with validation
    let messageToSend;
    let hasMedia = false;

    if (req.file) {
      messageToSend = MessageMedia.fromFilePath(req.file.path);
      if (message) {
        messageToSend.caption = message;
      }
      hasMedia = true;
    } else if (media) {
      // Validate base64 media and strip any "data:<mime>;base64," prefix (MessageMedia needs raw base64;
      // leaving the prefix in corrupts images/PDFs)
      const parsedMedia = parseBase64Media(media);
      if (!parsedMedia) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid base64 media format'
        });
      }

      // An explicit mimetype wins; otherwise use the one from the data URL
      const effectiveMimetype = mimetype || parsedMedia.mimetype;

      // Validate mimetype
      if (effectiveMimetype && !ALLOWED_MIME_TYPES.includes(effectiveMimetype)) {
        return res.status(400).json({
          ok: false,
          error: `Invalid mimetype. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`
        });
      }

      // Sanitize filename
      const safeFilename = filename ? sanitizeFilename(filename) : 'file';

      messageToSend = new MessageMedia(effectiveMimetype || 'application/octet-stream', parsedMedia.data, safeFilename);
      if (message) {
        messageToSend.caption = message;
      }
      hasMedia = true;
    } else if (message && message.trim()) {
      messageToSend = message;
    } else {
      return res.status(400).json({
        ok: false,
        error: 'Either message or file is required'
      });
    }

    // Queue message with anti-detection system
    let sentMessage, groupName = 'Group';

    try {
      await queueMessage(groupId, message, hasMedia, async () => {
        // Send message and get chat info in parallel
        const [sent, chat] = await Promise.allSettled([
          client.sendMessage(groupId, messageToSend, { sendSeen: false }),
          client.getChatById(groupId).catch(() => null)
        ]);

        // Handle results
        if (sent.status === 'rejected') {
          throw sent.reason;
        }

        sentMessage = sent.value;
        groupName = (chat.status === 'fulfilled' && chat.value && chat.value.isGroup)
          ? chat.value.name
          : 'Group';
      });
    } catch (queueError) {
      throw queueError;
    }

    // The library returns nothing when the chat cannot be found. Say so clearly instead of crashing with
    // "Cannot read properties of undefined (reading 'id')".
    if (!sentMessage) {
      throw new Error('WhatsApp did not confirm the message (chat not found or number not on WhatsApp)');
    }
    const sentId = sentMessage.id && sentMessage.id._serialized ? sentMessage.id._serialized : null;

    // Send response
    res.json({
      ok: true,
      id: sentId,
      messageId: sentId,
      timestamp: sentMessage.timestamp,
      groupName: groupName,
      hasMedia: hasMedia,
      queued: messageQueue.length > 0,
      queuePosition: messageQueue.length
    });
  } catch (err) {
    console.error('Error sending message:', err);
    // Check if error is due to session being closed or the page's script context being broken
    if (isSessionBrokenError(err)) {
      if (!isLoggingOut && !isClientDestroyed) {
        console.log('Session broken detected in send-group. Attempting to reinitialize...');
        reinitializeClient();
      }
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp session is being reset. Please try again in a moment.',
        reconnecting: true
      });
    }
    // Return actual error for debugging (WhatsApp errors like "Number not on WhatsApp" are user-actionable)
    const errorMessage = (err && err.message) ? String(err.message) : 'Failed to send message';

    res.status(500).json({ ok: false, error: errorMessage });
  }
});

/**
 * Send message to contact (personal message, with optional media)
 * POST /send-contact
 * body: { "contactId": "1234567890@c.us", "message": "Hello!", "media": "base64string" (optional), "mimetype": "image/jpeg" (optional), "filename": "image.jpg" (optional) }
 * OR multipart/form-data with file field
 */
app.post('/send-contact', handleFileUpload, async (req, res) => {
  // Handle multer errors gracefully
  if (req.fileValidationError) {
    return res.status(400).json({
      ok: false,
      error: req.fileValidationError
    });
  }

  try {
    // Quick validation checks first
    if (isClientDestroyed || isLoggingOut) {
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp client is being reset. Please wait...'
      });
    }

    if (!client || !client.info) {
      return res.status(503).json({ ok: false, error: 'WhatsApp client not ready yet' });
    }

    // Get and validate form data
    const rawContactId = req.body.contactId ? String(req.body.contactId).trim() : '';
    let message = req.body.message ? String(req.body.message) : '';
    const media = req.body.media ? String(req.body.media) : null;
    const mimetype = req.body.mimetype ? String(req.body.mimetype).trim() : null;
    const filename = req.body.filename ? String(req.body.filename).trim() : null;

    // Validate contactId format (raw phone numbers are normalized to "<digits>@c.us"; "@lid" ids are accepted)
    if (!rawContactId) {
      return res.status(400).json({
        ok: false,
        error: 'contactId is required'
      });
    }

    const contactId = normalizeContactId(rawContactId);
    if (!contactId) {
      // Log the actual value for debugging (only in development)
      if (process.env.NODE_ENV === 'development') {
        console.log('Invalid contactId received:', JSON.stringify(rawContactId));
      }
      return res.status(400).json({
        ok: false,
        error: `Invalid contactId format. Received: "${rawContactId.substring(0, 50)}". Expected format: number@c.us, id@lid, or a plain phone number (e.g., 1234567890@c.us)`
      });
    }

    // Sanitize message
    message = sanitizeMessage(message);

    // Prepare message/media in parallel
    let messageToSend;
    let hasMedia = false;

    if (req.file) {
      messageToSend = MessageMedia.fromFilePath(req.file.path);
      if (message) {
        messageToSend.caption = message;
      }
      hasMedia = true;
    } else if (media) {
      // Validate base64 media and strip any "data:<mime>;base64," prefix (MessageMedia needs raw base64;
      // leaving the prefix in corrupts images/PDFs)
      const parsedMedia = parseBase64Media(media);
      if (!parsedMedia) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid base64 media format'
        });
      }

      // An explicit mimetype wins; otherwise use the one from the data URL
      const effectiveMimetype = mimetype || parsedMedia.mimetype;

      // Validate mimetype
      if (effectiveMimetype && !ALLOWED_MIME_TYPES.includes(effectiveMimetype)) {
        return res.status(400).json({
          ok: false,
          error: `Invalid mimetype. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`
        });
      }

      // Sanitize filename
      const safeFilename = filename ? sanitizeFilename(filename) : 'file';

      messageToSend = new MessageMedia(effectiveMimetype || 'application/octet-stream', parsedMedia.data, safeFilename);
      if (message) {
        messageToSend.caption = message;
      }
      hasMedia = true;
    } else if (message && message.trim()) {
      messageToSend = message;
    } else {
      return res.status(400).json({
        ok: false,
        error: 'Either message or file is required'
      });
    }

    // Queue message with anti-detection system
    let sentMessage, contactName = contactId;

    try {
      await queueMessage(contactId, message, hasMedia, async () => {
        // Send message and get chat info in parallel
        const [sent, chat] = await Promise.allSettled([
          client.sendMessage(contactId, messageToSend, { sendSeen: false }),
          client.getChatById(contactId).catch(() => null)
        ]);

        // Handle results
        if (sent.status === 'rejected') {
          throw sent.reason;
        }

        sentMessage = sent.value;
        contactName = (chat.status === 'fulfilled' && chat.value && !chat.value.isGroup)
          ? (chat.value.name || contactId)
          : contactId;
      });
    } catch (queueError) {
      throw queueError;
    }

    // The library returns nothing when the chat cannot be found. Say so clearly instead of crashing with
    // "Cannot read properties of undefined (reading 'id')".
    if (!sentMessage) {
      throw new Error('WhatsApp did not confirm the message (chat not found or number not on WhatsApp)');
    }
    const sentId = sentMessage.id && sentMessage.id._serialized ? sentMessage.id._serialized : null;

    // Send response
    res.json({
      ok: true,
      id: sentId,
      messageId: sentId,
      timestamp: sentMessage.timestamp,
      contactName: contactName,
      hasMedia: hasMedia,
      queued: messageQueue.length > 0,
      queuePosition: messageQueue.length
    });
  } catch (err) {
    console.error('Error sending message to contact:', err);
    // Check if error is due to session being closed or the page's script context being broken
    if (isSessionBrokenError(err)) {
      if (!isLoggingOut && !isClientDestroyed) {
        console.log('Session broken detected in send-contact. Attempting to reinitialize...');
        reinitializeClient();
      }
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp session is being reset. Please try again in a moment.',
        reconnecting: true
      });
    }
    // Return actual error (WhatsApp errors like "Number not on WhatsApp" are user-actionable)
    const errorMessage = (err && err.message) ? String(err.message) : 'Failed to send message';

    res.status(500).json({ ok: false, error: errorMessage });
  }
});

/**
 * Reset/Refresh groups and contacts list
 * POST /api/reset-list
 * Forces a fresh fetch from WhatsApp and validates all groups/contacts
 */
app.post('/api/reset-list', async (req, res) => {
  try {
    if (isClientDestroyed || isLoggingOut) {
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp client is being reset. Please wait...'
      });
    }

    if (!client || !client.info) {
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp client not ready yet'
      });
    }

    // Force refresh by getting fresh chats
    let chats;
    try {
      chats = await Promise.race([
        client.getChats(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout getting chats')), 30000)
        )
      ]);
    } catch (chatError) {
      console.error('Error getting chats for reset:', chatError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to refresh list. Please try again.'
      });
    }

    // Validate and filter groups
    const groups = [];
    const contacts = [];

    for (const chat of chats) {
      try {
        if (chat.isGroup) {
          const groupId = chat.id._serialized;
          if (groupId && groupId.endsWith('@g.us')) {
            groups.push({
              id: groupId,
              name: chat.name || 'Unnamed Group',
              participants: chat.participants?.length || null
            });
          }
        } else if (!chat.isMe) {
          const contactId = chat.id._serialized;
          if (contactId && (contactId.endsWith('@c.us') || contactId.endsWith('@lid'))) {
            const userId = chat.id?.user || contactId.split('@')[0] || null;
            contacts.push({
              id: contactId,
              name: chat.name || userId || 'Unknown',
              number: userId || null
            });
          }
        }
      } catch (err) {
        // Skip invalid chats
        console.log(`Skipping invalid chat: ${chat.id?._serialized || 'unknown'}`);
      }
    }

    res.json({
      ok: true,
      groups,
      contacts,
      groupsCount: groups.length,
      contactsCount: contacts.length,
      message: 'List refreshed successfully'
    });
  } catch (err) {
    console.error('Error resetting list:', err);
    const errorMessage = process.env.NODE_ENV === 'development'
      ? err.message || 'Failed to reset list'
      : 'Failed to reset list';

    res.status(500).json({
      ok: false,
      error: errorMessage
    });
  }
});

/**
 * Get client status
 * GET /status
 */
app.get('/status', (req, res) => {
  const ready = !!(client && client.info && !isClientDestroyed && !isLoggingOut);
  const hasClient = !!client;
  const restoring = hasClient && !client.info && !isLoggingOut && !isClientDestroyed && !currentQRCode;
  res.json({
    ok: true,
    ready,
    restoring,
    isLoggingOut: isLoggingOut,
    info: (client && client.info && !isClientDestroyed && !isLoggingOut) ? {
      wid: client.info.wid.user,
      pushname: client.info.pushname
    } : null,
    antiDetection: {
      queueLength: messageQueue.length,
      isProcessing: isProcessingQueue,
      messageCountInWindow: messageCountInWindow,
      cooldownUntil: cooldownUntil > Date.now() ? cooldownUntil : null,
      config: ANTI_DETECTION_CONFIG
    }
  });
});

/**
 * Get QR code (if available)
 * GET /api/qr
 */
app.get('/api/qr', (req, res) => {
  res.json({
    ok: true,
    hasQR: !!currentQRCode,
    qr: currentQRCode,
    ready: !!(client && client.info && !isClientDestroyed),
    isLoggingOut: isLoggingOut
  });
});

/**
 * Get QR code as image (for direct viewing/refresh)
 * GET /api/qr-image - Open in new tab if dashboard QR won't load
 */
app.get('/api/qr-image', (req, res) => {
  if (!currentQRCode) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(404).send(`
      <html><head><title>QR Code</title><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;">
        <h2>QR code not ready yet</h2>
        <p>Waiting for WhatsApp to generate QR code... This page will auto-refresh every 3 seconds.</p>
        <p><a href="/api/qr-image">Refresh now</a> | <a href="/">Back to Dashboard</a></p>
      </body></html>
    `);
  }
  const base64Data = currentQRCode.replace(/^data:image\/png;base64,/, '');
  const imgBuffer = Buffer.from(base64Data, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(imgBuffer);
});

/**
 * Server-Sent Events endpoint for real-time QR code updates
 * GET /api/qr-stream
 */
app.get('/api/qr-stream', (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // CORS is handled by cors middleware, but keep for SSE compatibility
  if (corsOptions.origin !== '*') {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  // A broken pipe (EPIPE/ECONNRESET) is emitted as an 'error' event on the response, NOT thrown, so the
  // try/catch around res.write cannot see it. Without a listener Node escalates it to an
  // uncaughtException and the whole process shuts down.
  let heartbeat = null;
  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    qrCodeListeners.delete(res);
  };
  res.on('error', (err) => {
    if (err && err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      console.warn('SSE stream error:', err.message);
    }
    cleanup();
  });
  req.on('error', cleanup);
  req.on('close', () => {
    cleanup();
    res.end();
  });

  // Send initial state
  try {
    res.write(`data: ${JSON.stringify({
      qr: currentQRCode,
      hasQR: !!currentQRCode,
      connected: !!(client && client.info)
    })}\n\n`);
  } catch (err) {
    console.error('Error sending initial SSE data:', err);
    cleanup();
    return res.end();
  }

  // Add this response to listeners (using Set for O(1) operations)
  qrCodeListeners.add(res);

  // Keep connection alive with heartbeat
  heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      cleanup();
      res.end();
    }
  }, 30000); // 30 seconds
});

/**
 * Logout and clear session
 * POST /api/logout
 */
app.post('/api/logout', async (req, res) => {
  // Ensure we always return JSON
  res.setHeader('Content-Type', 'application/json');

  try {
    // Prevent concurrent logout operations
    if (isLoggingOut) {
      return res.json({
        ok: false,
        error: 'Logout already in progress. Please wait...'
      });
    }

    if (!client || !client.info) {
      return res.json({
        ok: false,
        error: 'No active session to logout'
      });
    }

    // Set flags
    isLoggingOut = true;
    isClientDestroyed = true;

    console.log('Logging out WhatsApp client...');

    // Send response immediately to prevent timeout
    res.json({
      ok: true,
      message: 'Logging out... Please wait for new QR code.'
    });

    // Perform logout asynchronously
    (async () => {
      try {
        // Logout from WhatsApp
        try {
          await Promise.race([
            client.logout(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Logout timeout')), 10000))
          ]);
        } catch (err) {
          console.warn('Error during client logout:', err.message);
          // Continue with session cleanup even if logout fails
        }

        // Destroy the client
        try {
          await Promise.race([
            client.destroy(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Destroy timeout')), 10000))
          ]);
        } catch (err) {
          console.warn('Error destroying client:', err.message);
        }

        // Clear auth session folder
        await clearAuthSession();

        // Clear QR code state
        currentQRCode = null;
        notifyQRListeners({ qr: null, hasQR: false, connected: false, loggedOut: true });

        // Reset flags after a delay
        setTimeout(() => {
          isClientDestroyed = false;
          isLoggingOut = false;
        }, 2000);

        // Create new client instance for new scan
        setTimeout(() => {
          console.log('Creating new client instance for new scan...');
          try {
            client = new Client(clientConfig);
            setupClientEvents();
            initializeClient(client);
          } catch (err) {
            console.error('Error creating new client:', err);
            isLoggingOut = false;
            isClientDestroyed = false;
          }
        }, 1500);

      } catch (err) {
        console.error('Error during async logout:', err);
        isLoggingOut = false;
        isClientDestroyed = false;
        notifyQRListeners({
          qr: null,
          hasQR: false,
          connected: false,
          loggedOut: true,
          error: 'Logout completed with warnings'
        });
      }
    })();

  } catch (err) {
    console.error('Error during logout:', err);
    isLoggingOut = false;
    isClientDestroyed = false;
    res.status(500).json({
      ok: false,
      error: err.message || 'Failed to logout'
    });
  }
});

/**
 * Force a new QR code (clear saved session and reinitialize)
 * Use when stuck on "QR code not available yet" or "Restoring session..."
 * POST /api/force-qr
 */
app.post('/api/force-qr', async (req, res) => {
  try {
    const result = await forceNewQR();
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('Error in /api/force-qr:', err);
    res.status(500).json({ ok: false, error: err.message || 'Failed to force new QR.' });
  }
});

// ============================================
// SECURITY & OPTIMIZATION MIDDLEWARE
// ============================================

// NOTE: the request timeout middleware is registered at the top of this file (before the routes).

// Global error handler (catch-all for unhandled errors)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  // Don't send error response if headers already sent
  if (res.headersSent) {
    return next(err);
  }

  // Security: Don't expose error details in production
  const errorMessage = process.env.NODE_ENV === 'development'
    ? err.message || 'Internal server error'
    : 'Internal server error';

  res.status(err.status || 500).json({
    ok: false,
    error: errorMessage,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint not found' });
});

// ============================================
// GRACEFUL SHUTDOWN HANDLING
// ============================================

let server;

function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      console.log('HTTP server closed.');

      // Cleanup WhatsApp client
      if (client) {
        console.log('Cleaning up WhatsApp client...');
        client.destroy().catch(console.error);
      }

      // Cleanup message history to prevent memory leaks
      messageHistory.length = 0;
      messageQueue.length = 0;

      console.log('Graceful shutdown complete.');
      process.exit(0);
    });

    // Force close after 10 seconds
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  // Network-level noise from a client that went away (e.g. SSE/HTTP socket) is not fatal
  if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_WRITE_AFTER_END')) {
    console.warn('Ignored connection error:', err.code);
    return;
  }
  console.error('Uncaught Exception:', err);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason?.message || String(reason);
  if (msg.includes('Target closed') || msg.includes('Protocol error') || (reason?.name === 'ProtocolError')) {
    if (Date.now() - lastProtocolErrorLog > 30000) {
      lastProtocolErrorLog = Date.now();
      console.log('Browser session reset (normal during reconnect). If QR not showing, restart the server.');
    }
    return;
  }
  console.error('Unhandled Rejection:', reason);
});

// ============================================
// MEMORY LEAK PREVENTION
// ============================================

// Cleanup old message history periodically (prevent memory leaks)
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  const initialLength = messageHistory.length;

  // Remove messages older than 24 hours (iterate backwards for safe splice)
  for (let i = messageHistory.length - 1; i >= 0; i--) {
    if (now - messageHistory[i].timestamp > maxAge) {
      messageHistory.splice(i, 1);
    }
  }
  // Ensure we don't exceed max size
  if (messageHistory.length > MAX_HISTORY_SIZE) {
    messageHistory.splice(0, messageHistory.length - MAX_HISTORY_SIZE);
  }
}, 60 * 60 * 1000); // Run every hour

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Security warning for production
if (NODE_ENV === 'production') {
  console.warn('⚠️  PRODUCTION MODE');
  console.warn('⚠️  Make sure to:');
  console.warn('   1. Use HTTPS (reverse proxy with SSL)');
  console.warn('   2. Set ALLOWED_ORIGINS environment variable');
  console.warn('   3. Set API_KEY for authentication');
  console.warn('   4. Configure firewall rules');
  console.warn('   5. Use a process manager (PM2, systemd)');
}

server = app.listen(PORT, () => {
  console.log(`\n✅ WhatsApp API listening on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/`);
  console.log(`🔍 API Health: http://localhost:${PORT}/api/health`);
  console.log(`📋 List groups: http://localhost:${PORT}/list-groups`);
  console.log(`\nEnvironment: ${NODE_ENV}`);
  console.log(`Security: ${helmet ? 'Enabled' : 'Disabled'}`);
  console.log(`Rate Limiting: Enabled`);
  console.log(`Anti-Detection: Enabled\n`);
});

