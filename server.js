// server.js
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For form data

// Configure multer for file uploads
const uploadDir = path.join(__dirname, 'uploads');
// Ensure uploads directory exists
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow all file types
    cb(null, true);
  }
});

// Middleware to handle both JSON and multipart/form-data
const handleFileUpload = (req, res, next) => {
  // If content-type is application/json, skip multer
  if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
    return next();
  }
  // Otherwise use multer for multipart/form-data
  return upload.single('file')(req, res, next);
};

// Store current QR code data
let currentQRCode = null;
const qrCodeListeners = new Set(); // Use Set for better performance
let isLoggingOut = false; // Flag to prevent concurrent logout operations
let isClientDestroyed = false; // Flag to track if client is being destroyed

// Serve static files (dashboard)
app.use(express.static('public'));

// Optional: Enable API key authentication for security
// Uncomment the following lines to require X-API-Key header:
// const { apiKeyAuth } = require('./middleware');
// app.use(apiKeyAuth);

// Client configuration
const clientConfig = {
  authStrategy: new LocalAuth({ clientId: "my-instance" }),
  puppeteer: {
    // If running on server you may need some flags; be careful with headless on some servers
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process'
    ]
  }
};

// Create client instance
let client = new Client(clientConfig);

// Setup client event handlers
function setupClientEvents() {
  client.on('qr', async (qr) => {
    console.log('--- Scan this QR with your WhatsApp phone ---');
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
      console.log('Groups request: client is null');
      return res.status(503).json({ 
        ok: false, 
        error: 'WhatsApp client not initialized. Please wait...' 
      });
    }

    if (!client.info) {
      console.log('Groups request: client.info is null');
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
      if (chatError.message && chatError.message.includes('Session closed')) {
        return res.status(503).json({ 
          ok: false, 
          error: 'WhatsApp session closed. Please refresh or reconnect.' 
        });
      }
      throw chatError;
    }

    const groups = chats
      .filter(c => c.isGroup)
      .map(g => ({ 
        id: g.id._serialized, 
        name: g.name, 
        participants: g.participants?.length || null 
      }));
    
    res.json({ ok: true, groups, count: groups.length });
  } catch (err) {
    console.error('Error listing groups:', err);
    // Check if error is due to session being closed
    if (err.message && (err.message.includes('Session closed') || err.message.includes('Protocol error'))) {
      return res.status(503).json({ 
        ok: false, 
        error: 'WhatsApp session error. Please refresh the page or reconnect.' 
      });
    }
    res.status(500).json({ 
      ok: false, 
      error: err.message || 'Failed to list groups',
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
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
      console.log('Contacts request: client is null');
      return res.status(503).json({ 
        ok: false, 
        error: 'WhatsApp client not initialized. Please wait...' 
      });
    }

    if (!client.info) {
      console.log('Contacts request: client.info is null');
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
      if (chatError.message && chatError.message.includes('Session closed')) {
        return res.status(503).json({ 
          ok: false, 
          error: 'WhatsApp session closed. Please refresh or reconnect.' 
        });
      }
      throw chatError;
    }

    const contacts = chats
      .filter(c => !c.isGroup && !c.isMe) // Exclude groups and self
      .map(c => ({ 
        id: c.id._serialized, 
        name: c.name || c.id.user || 'Unknown',
        number: c.id.user || null
      }));
    
    res.json({ ok: true, contacts, count: contacts.length });
  } catch (err) {
    console.error('Error listing contacts:', err);
    // Check if error is due to session being closed
    if (err.message && (err.message.includes('Session closed') || err.message.includes('Protocol error'))) {
      return res.status(503).json({ 
        ok: false, 
        error: 'WhatsApp session error. Please refresh the page or reconnect.' 
      });
    }
    res.status(500).json({ 
      ok: false, 
      error: err.message || 'Failed to list contacts',
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
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

    // Get form data
    const groupId = req.body.groupId;
    const message = req.body.message || '';
    const media = req.body.media;
    const mimetype = req.body.mimetype;
    const filename = req.body.filename;
    
    if (!groupId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'groupId is required' 
      });
    }

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
      messageToSend = MessageMedia.fromBase64(media, mimetype || 'application/octet-stream', filename || 'file');
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

    // Send message and get chat info in parallel for speed
    const [sent, chat] = await Promise.allSettled([
      client.sendMessage(groupId, messageToSend),
      client.getChatById(groupId).catch(() => null)
    ]);
    
    // Handle results
    if (sent.status === 'rejected') {
      throw sent.reason;
    }
    
    const groupName = (chat.status === 'fulfilled' && chat.value && chat.value.isGroup) 
      ? chat.value.name 
      : 'Group';
    
    // Send response immediately
    res.json({ 
      ok: true, 
      id: sent.value.id._serialized,
      timestamp: sent.value.timestamp,
      groupName: groupName,
      hasMedia: hasMedia
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
    res.status(500).json({ ok: false, error: err.message || 'Failed to send message' });
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

    // Get form data
    const contactId = req.body.contactId;
    const message = req.body.message || '';
    const media = req.body.media;
    const mimetype = req.body.mimetype;
    const filename = req.body.filename;
    
    if (!contactId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'contactId is required' 
      });
    }

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
      messageToSend = MessageMedia.fromBase64(media, mimetype || 'application/octet-stream', filename || 'file');
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

    // Send message and get chat info in parallel for speed
    const [sent, chat] = await Promise.allSettled([
      client.sendMessage(contactId, messageToSend),
      client.getChatById(contactId).catch(() => null)
    ]);
    
    // Handle results
    if (sent.status === 'rejected') {
      throw sent.reason;
    }
    
    const contactName = (chat.status === 'fulfilled' && chat.value && !chat.value.isGroup) 
      ? (chat.value.name || contactId)
      : contactId;
    
    // Send response immediately
    res.json({ 
      ok: true, 
      id: sent.value.id._serialized,
      timestamp: sent.value.timestamp,
      contactName: contactName,
      hasMedia: hasMedia
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
    res.status(500).json({ ok: false, error: err.message || 'Failed to send message' });
  }
});

/**
 * Get client status
 * GET /status
 */
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    ready: !!(client && client.info && !isClientDestroyed),
    isLoggingOut: isLoggingOut,
    info: (client && client.info && !isClientDestroyed) ? {
      wid: client.info.wid.user,
      pushname: client.info.pushname
    } : null
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
 * Server-Sent Events endpoint for real-time QR code updates
 * GET /api/qr-stream
 */
app.get('/api/qr-stream', (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WhatsApp API listening on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/`);
  console.log(`🔍 API Health: http://localhost:${PORT}/api/health`);
  console.log(`📋 List groups: http://localhost:${PORT}/list-groups`);
});

