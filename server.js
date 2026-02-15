// server.js
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

const app = express();

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

// Compression for better performance
app.use(compression());

// Request size limits (prevent DoS)
app.use(express.json({ limit: '10mb' })); // Limit JSON payloads
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Limit form data

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { ok: false, error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
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
});

app.use('/api/', limiter); // Apply to all API routes
app.use('/send-group', sendMessageLimiter);
app.use('/send-contact', sendMessageLimiter);



// Configure multer for file uploads with security
const uploadDir = path.join(__dirname, 'uploads');
// Ensure uploads directory exists
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);

// Allowed file types (security: restrict file types)
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
  let sanitized = filename.replace(/\.\./g, '').replace(/[\/\\]/g, '_');
  // Remove any non-alphanumeric characters except dots, hyphens, underscores
  sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Limit length
  if (sanitized.length > 255) {
    const ext = path.extname(sanitized);
    sanitized = sanitized.substring(0, 255 - ext.length) + ext;
  }
  return sanitized;
}

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
    next();
  });
};

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

// Process message queue
async function processMessageQueue() {
  if (isProcessingQueue || messageQueue.length === 0) {
    return;
  }
  
  isProcessingQueue = true;
  
  while (messageQueue.length > 0) {
    const queueItem = messageQueue[0];
    
    // Check if we need to wait
    const waitTime = shouldWait();
    if (waitTime > 0) {
      console.log(`⏳ Anti-detection: Waiting ${Math.round(waitTime/1000)}s before sending next message...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Check for suspicious patterns
    if (detectSuspiciousPattern(queueItem.recipientId, queueItem.message || '')) {
      console.warn('⚠️  Suspicious pattern detected! Adding extra delay...');
      await new Promise(resolve => setTimeout(resolve, ANTI_DETECTION_CONFIG.cooldownPeriod));
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
      }, ANTI_DETECTION_CONFIG.cooldownPeriod);
      
    } catch (error) {
      console.error('Error processing queued message:', error);
      if (queueItem.reject) {
        queueItem.reject(error);
      }
    }
  }
  
  isProcessingQueue = false;
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

// Input validation helpers
function validateGroupId(groupId) {
  if (!groupId || typeof groupId !== 'string') return false;
  const trimmed = groupId.trim();
  // WhatsApp group ID format: must end with @g.us
  // More flexible validation - accepts any format ending with @g.us
  // WhatsApp library will handle actual format validation
  return trimmed.endsWith('@g.us') && trimmed.length > 6 && !trimmed.includes(' ');
}

function validateContactId(contactId) {
  if (!contactId || typeof contactId !== 'string') return false;
  const trimmed = contactId.trim();
  // WhatsApp contact ID format: must end with @c.us
  // More flexible validation - accepts any format ending with @c.us
  // WhatsApp library will handle actual format validation
  return trimmed.endsWith('@c.us') && trimmed.length > 6 && !trimmed.includes(' ');
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'string') return '';
  // Trim and limit length (WhatsApp has a 4096 character limit)
  return message.trim().substring(0, 4096);
}

function validateBase64Media(media) {
  if (!media || typeof media !== 'string') return false;
  // Basic base64 validation
  const base64Regex = /^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,([A-Za-z0-9+/=]+)$/;
  return base64Regex.test(media) || /^[A-Za-z0-9+/=]+$/.test(media);
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
const clientConfig = {
  authStrategy: new LocalAuth({ clientId: "my-instance" }),
  // Use 'local' cache - 'none' can fetch versions WhatsApp rejects for linking
  webVersionCache: { type: 'local' },
  // Modern Chrome user agent (helps avoid "could not link device" in some cases)
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  puppeteer: {
    headless: true,
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
  client.on('authenticated', () => {});
  client.on('qr', async (qr) => {
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
  console.log('WhatsApp client ready.');
    // Clear QR code when connected
    currentQRCode = null;
    // Reset flags when client is ready
    isClientDestroyed = false;
    isLoggingOut = false;
    notifyQRListeners({ qr: null, hasQR: false, connected: true });
});

client.on('auth_failure', msg => {
  console.error('Auth failure:', msg);
    notifyQRListeners({ qr: null, hasQR: false, connected: false, authFailure: true });
});

client.on('disconnected', (reason) => {
  console.log('Client disconnected:', reason);
    currentQRCode = null;
    // Reset flags if disconnected (not during logout)
    if (!isLoggingOut) {
      isClientDestroyed = false;
    }
    notifyQRListeners({ qr: null, hasQR: false, connected: false });
    
    // Auto-reconnect if session was closed unexpectedly (not during logout)
    if (!isLoggingOut && (reason === 'NAVIGATION' || reason === 'CONFLICT' || reason === 'LOGGED_OUT')) {
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

// Helper function to clear auth session
async function clearAuthSession() {
  const authPath = path.join(process.cwd(), '.wwebjs_auth');
  try {
    await fs.rm(authPath, { recursive: true, force: true });
    console.log('Auth session cleared');
    return true;
  } catch (err) {
    console.error('Error clearing auth session:', err);
    return false;
  }
}

// Helper function to reinitialize client when session is closed
function reinitializeClient() {
  if (isLoggingOut || isClientDestroyed) {
    console.log('Skipping reinitialize - logout in progress or client destroyed');
    return;
  }

  try {
    console.log('Reinitializing WhatsApp client...');
    isClientDestroyed = true; // Prevent new requests during reinit

    // Destroy existing client if it exists
    if (client) {
      client.destroy().catch(err => {
        console.warn('Error destroying old client during reinit:', err.message);
      });
    }

    // Create new client instance
    client = new Client(clientConfig);
    setupClientEvents();
    client.initialize();

    console.log('Client reinitialization started. Waiting for QR code or connection...');
  } catch (err) {
    console.error('Error reinitializing client:', err);
    isClientDestroyed = false;
  }
}

/**
 * Force a fresh QR by clearing saved session and reinitializing (use when stuck "restoring" or QR never appears)
 */
async function forceNewQR() {
  if (isLoggingOut || isClientDestroyed) {
    console.log('Skipping forceNewQR - logout in progress or client destroyed');
    return { ok: false, error: 'Please wait, operation in progress.' };
  }
  try {
    console.log('Force new QR: clearing session and reinitializing...');
    isClientDestroyed = true;
    currentQRCode = null;
    notifyQRListeners({ qr: null, hasQR: false, connected: false });

    if (client) {
      client.destroy().catch(() => {});
      client = null;
    }

    const cleared = await clearAuthSession();
    if (!cleared) {
      isClientDestroyed = false;
      return { ok: false, error: 'Failed to clear session folder.' };
    }

    // New client with fresh auth (no saved session = will emit QR)
    client = new Client(clientConfig);
    setupClientEvents();
    client.initialize();
    isClientDestroyed = false;
    console.log('Client reinitialized. QR code should appear shortly.');
    return { ok: true, message: 'Session cleared. QR code will appear in 15–60 seconds.' };
  } catch (err) {
    console.error('Error in forceNewQR:', err);
    isClientDestroyed = false;
    return { ok: false, error: err.message || 'Failed to force new QR.' };
  }
}

client.initialize();

/**
 * Health check endpoint (API)
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({ 
    ok: true, 
    message: 'WhatsApp API is running',
    status: client.info ? 'connected' : 'connecting'
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
      if (chatError.message && (chatError.message.includes('Session closed') || chatError.message.includes('Protocol error'))) {
        // Attempt to reinitialize if session is closed
        if (!isLoggingOut && !isClientDestroyed) {
          console.log('Session closed detected. Attempting to reinitialize...');
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
    if (err.message && (err.message.includes('Session closed') || err.message.includes('Protocol error'))) {
      // Attempt to reinitialize if session is closed
      if (!isLoggingOut && !isClientDestroyed) {
        console.log('Session closed detected in error handler. Attempting to reinitialize...');
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
      if (chatError.message && (chatError.message.includes('Session closed') || chatError.message.includes('Protocol error'))) {
        // Attempt to reinitialize if session is closed
        if (!isLoggingOut && !isClientDestroyed) {
          console.log('Session closed detected. Attempting to reinitialize...');
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
    if (err.message && (err.message.includes('Session closed') || err.message.includes('Protocol error'))) {
      // Attempt to reinitialize if session is closed
      if (!isLoggingOut && !isClientDestroyed) {
        console.log('Session closed detected in error handler. Attempting to reinitialize...');
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
  let uploadedFilePath = null;
  
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
    const groupId = req.body.groupId ? String(req.body.groupId).trim() : '';
    let message = req.body.message ? String(req.body.message) : '';
    const media = req.body.media ? String(req.body.media) : null;
    const mimetype = req.body.mimetype ? String(req.body.mimetype).trim() : null;
    const filename = req.body.filename ? String(req.body.filename).trim() : null;
    
    // Validate groupId format
    if (!groupId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'groupId is required' 
      });
    }
    
    if (!validateGroupId(groupId)) {
      // Log the actual value for debugging (only in development)
      if (process.env.NODE_ENV === 'development') {
        console.log('Invalid groupId received:', JSON.stringify(groupId));
      }
      return res.status(400).json({ 
        ok: false, 
        error: `Invalid groupId format. Received: "${groupId.substring(0, 50)}". Expected format: numbers-numbers@g.us (e.g., 123456789-123456789@g.us)` 
      });
    }
    
    // Sanitize message
    message = sanitizeMessage(message);

    // Prepare message/media in parallel with validation
    let messageToSend;
    let hasMedia = false;
    
    if (req.file) {
      uploadedFilePath = req.file.path;
      messageToSend = MessageMedia.fromFilePath(uploadedFilePath);
      if (message) {
        messageToSend.caption = message;
      }
      hasMedia = true;
    } else if (media) {
      // Validate base64 media
      if (!validateBase64Media(media)) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Invalid base64 media format' 
        });
      }
      
      // Validate mimetype if provided
      if (mimetype && !ALLOWED_MIME_TYPES.includes(mimetype)) {
      return res.status(400).json({ 
        ok: false, 
          error: `Invalid mimetype. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}` 
        });
      }
      
      // Sanitize filename
      const safeFilename = filename ? sanitizeFilename(filename) : 'file';
      
      messageToSend = new MessageMedia(mimetype || 'application/octet-stream', media, safeFilename);
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
    
    // Send response
    res.json({ 
      ok: true, 
      id: sentMessage.id._serialized,
      timestamp: sentMessage.timestamp,
      groupName: groupName,
      hasMedia: hasMedia,
      queued: messageQueue.length > 0,
      queuePosition: messageQueue.length
    });
    
    // Clean up file asynchronously (don't wait)
    if (uploadedFilePath) {
      fs.unlink(uploadedFilePath).catch(console.error);
    }
  } catch (err) {
    console.error('Error sending message:', err);
    // Clean up file on error
    if (uploadedFilePath) {
      fs.unlink(uploadedFilePath).catch(console.error);
    }
    // Check if error is due to session being closed
    if (err.message && err.message.includes('Session closed')) {
      return res.status(503).json({ 
        ok: false, 
        error: 'WhatsApp session is being reset. Please try again.' 
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
  let uploadedFilePath = null;
  
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
    const contactId = req.body.contactId ? String(req.body.contactId).trim() : '';
    let message = req.body.message ? String(req.body.message) : '';
    const media = req.body.media ? String(req.body.media) : null;
    const mimetype = req.body.mimetype ? String(req.body.mimetype).trim() : null;
    const filename = req.body.filename ? String(req.body.filename).trim() : null;
    
    // Validate contactId format
    if (!contactId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'contactId is required' 
      });
    }
    
    if (!validateContactId(contactId)) {
      // Log the actual value for debugging (only in development)
      if (process.env.NODE_ENV === 'development') {
        console.log('Invalid contactId received:', JSON.stringify(contactId));
      }
      return res.status(400).json({ 
        ok: false, 
        error: `Invalid contactId format. Received: "${contactId.substring(0, 50)}". Expected format: number@c.us (e.g., 1234567890@c.us)` 
      });
    }
    
    // Sanitize message
    message = sanitizeMessage(message);

    // Prepare message/media in parallel
    let messageToSend;
    let hasMedia = false;
    
    if (req.file) {
      uploadedFilePath = req.file.path;
      messageToSend = MessageMedia.fromFilePath(uploadedFilePath);
      if (message) {
        messageToSend.caption = message;
      }
      hasMedia = true;
    } else if (media) {
      // Validate base64 media
      if (!validateBase64Media(media)) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Invalid base64 media format' 
        });
      }
      
      // Validate mimetype if provided
      if (mimetype && !ALLOWED_MIME_TYPES.includes(mimetype)) {
        return res.status(400).json({ 
          ok: false, 
          error: `Invalid mimetype. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}` 
        });
      }
      
      // Sanitize filename
      const safeFilename = filename ? sanitizeFilename(filename) : 'file';
      
      messageToSend = new MessageMedia(mimetype || 'application/octet-stream', media, safeFilename);
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
    
    // Send response
    res.json({ 
      ok: true, 
      id: sentMessage.id._serialized,
      timestamp: sentMessage.timestamp,
      contactName: contactName,
      hasMedia: hasMedia,
      queued: messageQueue.length > 0,
      queuePosition: messageQueue.length
    });
    
    // Clean up file asynchronously (don't wait)
    if (uploadedFilePath) {
      fs.unlink(uploadedFilePath).catch(console.error);
    }
  } catch (err) {
    console.error('Error sending message to contact:', err);
    // Clean up file on error
    if (uploadedFilePath) {
      fs.unlink(uploadedFilePath).catch(console.error);
    }
    // Check if error is due to session being closed
    if (err.message && err.message.includes('Session closed')) {
      return res.status(503).json({ 
        ok: false, 
        error: 'WhatsApp session is being reset. Please try again.' 
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
          if (contactId && contactId.endsWith('@c.us')) {
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

  // Send initial state
  try {
    res.write(`data: ${JSON.stringify({ 
      qr: currentQRCode, 
      hasQR: !!currentQRCode,
      connected: !!client.info 
    })}\n\n`);
  } catch (err) {
    console.error('Error sending initial SSE data:', err);
    return res.end();
  }

  // Add this response to listeners (using Set for O(1) operations)
  qrCodeListeners.add(res);

  // Remove listener when client disconnects
  req.on('close', () => {
    qrCodeListeners.delete(res);
    res.end();
  });

  // Keep connection alive with heartbeat
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      clearInterval(heartbeat);
      qrCodeListeners.delete(res);
      res.end();
    }
  }, 30000); // 30 seconds

  req.on('close', () => {
    clearInterval(heartbeat);
  });
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
            client.initialize();
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

// Request timeout middleware (prevent hanging requests)
app.use((req, res, next) => {
  req.setTimeout(60000, () => { // 60 second timeout
    if (!res.headersSent) {
      res.status(408).json({ ok: false, error: 'Request timeout' });
    }
  });
  next();
});

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
      if (client && client.info) {
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

