# WhatsApp Web Automation API

⚠️ **IMPORTANT WARNINGS**

- This is **unofficial automation**. WhatsApp may detect automation and **ban your phone number**.
- Use only on accounts you control and for **low-volume / internal automation**.
- **Don't use for spam**, harassing people, or anything illegal. That risks bans and legal consequences.
- Use a **separate WhatsApp account** for automation (not your main personal account).

## What This Does

This Node.js server provides an HTTP API to send messages to WhatsApp groups using `whatsapp-web.js`, which automates WhatsApp Web via Puppeteer.

## Features

- ✅ **Web Dashboard** - Beautiful, responsive web interface for managing WhatsApp messages
- ✅ List all groups and their IDs
- ✅ Send messages to groups and personal contacts via HTTP API or dashboard
- ✅ Session persistence (no re-scan after initial QR)
- ✅ Health check and status endpoints
- ✅ Real-time activity logging
- ✅ **Anti-Detection System** - Prevents WhatsApp from detecting automation and logging you out
- ✅ **File Upload Support** - Send images, PDFs, documents, videos, and audio files
- ✅ **Message Queue** - Automatic queuing with human-like delays
- ✅ **Security Features** - Rate limiting, input validation, file type restrictions

## Installation

```bash
# Install dependencies
npm install

# Start the server
npm start
```

## First Time Setup

1. Run `npm start`
2. A QR code will appear in the terminal
3. Open WhatsApp on your phone → Settings → Linked devices → Link a device
4. Scan the QR code
5. The session will be saved automatically (no need to scan again on restart)
6. Open your browser and go to `http://localhost:3000` to access the dashboard

## Web Dashboard

After starting the server, open your browser and navigate to:
```
http://localhost:3000
```

The dashboard provides:
- **Real-time connection status** - See if WhatsApp is connected
- **Group management** - View all your groups with participant counts
- **Send messages** - Easy-to-use form to send messages to groups
- **Activity log** - Track all sent messages and errors

The dashboard is fully responsive and works on desktop, tablet, and mobile devices.

## API Documentation

📖 **Complete API Documentation**: See [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) for detailed API reference with examples in multiple languages.

### Quick API Reference

**Base URL:** `http://localhost:3000`

**Available Endpoints:**
- `GET /api/health` - Health check
- `GET /status` - Get WhatsApp connection status and queue info
- `GET /list-groups` - List all groups
- `GET /list-contacts` - List all personal contacts
- `POST /send-group` - Send message/file to group
- `POST /send-contact` - Send message/file to contact
- `POST /api/reset-list` - Force refresh groups/contacts list
- `GET /api/qr` - Get QR code (base64)
- `GET /api/qr-stream` - Get QR code (SSE stream)
- `POST /api/logout` - Logout and clear session

### Quick Example

```bash
# Send a message to a group
curl -X POST http://localhost:3000/send-group \
  -H "Content-Type: application/json" \
  -d '{
    "groupId": "120363123456789012@g.us",
    "message": "Hello from API!"
  }'
```

For complete documentation with examples in Python, Node.js, PHP, and more, see [API_DOCUMENTATION.md](./API_DOCUMENTATION.md).

## Integrating into Other Projects

🔗 **Integration Guide**: See [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) for step-by-step instructions on how to use this API in your other projects (Node.js, Python, React, PHP, etc.).

The integration guide includes:
- Complete code examples for multiple languages
- How to set up the API client in your project
- Best practices for error handling and rate limiting
- Troubleshooting common issues
- Production deployment tips

## Finding Group IDs

The easiest way is to use the `/list-groups` endpoint. It returns all groups with their IDs and names.

Alternatively:
1. Open the group chat on your phone
2. Go to "Group Info" → Invite → "Invite to group via link"
3. The link may contain group information, but the API endpoint is more reliable

## Server Deployment

🚀 **Complete Deployment Guide**: See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) for detailed instructions on deploying to Railway, Render, DigitalOcean, AWS, and more.

### ⚠️ Important: Platform Compatibility

**❌ Vercel/Netlify Functions**: NOT compatible - This app requires long-running processes, persistent storage, and WebSocket connections. Serverless platforms won't work.

**✅ Recommended Platforms:**
- **Render** (100% FREE) - No credit card needed, forever free tier
- **Railway** (Easiest) - $5 credit/month, one-click deployment
- **DigitalOcean App Platform** - Reliable, $5/month
- **AWS EC2/Lightsail** - Full control, scalable (12 months free tier)

### Quick Deploy to Render (100% FREE)

1. Push your code to GitHub
2. Go to [render.com](https://render.com) and sign up (no credit card needed)
3. Click "New" → "Web Service"
4. Connect your GitHub repository
5. Render auto-detects and deploys
6. Get your public URL (e.g., `https://your-app.onrender.com`) and use it in your other projects!

**Note:** Render's free tier sleeps after 15 min inactivity but wakes automatically on first request.

### Requirements
- Node.js 16+
- Chrome/Chromium dependencies (for Puppeteer)
- On Linux servers, you may need:
  ```bash
  sudo apt-get install -y \
    chromium-browser \
    chromium-chromedriver
  ```

### Process Management (For VPS/EC2)
Use PM2 or systemd to keep the process running:

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start server.js --name whatsapp-api

# View logs
pm2 logs whatsapp-api
```

### Security (CRITICAL)

**Add authentication before deploying!** The current API is open to anyone. Options:

1. **API Key Middleware** (simple):
```javascript
const API_KEY = process.env.API_KEY;

app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});
```

2. **HTTPS + JWT** (recommended for production)

3. **Firewall** - Only allow specific IPs

### Environment Variables

Create a `.env` file:
```
PORT=3000
API_KEY=your-secret-api-key-here
```

## Limitations & Risks

- Meta can detect automation and ban your number
- You can lose the WhatsApp account permanently
- Some hosting providers block Chrome/Puppeteer
- Not suitable for high-volume messaging
- Session may be invalidated by WhatsApp

## Safer Alternatives

If you need reliability:
- **Telegram Bot API** - Official, free, reliable
- **Signal-CLI** - Official CLI automation
- **WhatsApp Cloud API** - Official business API (requires approval)
- **SMS/Email/Push** - For critical alerts

## Troubleshooting

### QR Code Not Appearing
- Make sure you're running in a terminal that supports QR codes
- Check that `qrcode-terminal` is installed

### Connection Issues
- Ensure your server has internet access
- Check firewall settings
- Verify Chrome/Chromium is installed

### Session Lost
- Delete `.wwebjs_auth/` folder and re-scan QR code
- WhatsApp may log you out if suspicious activity is detected

## Anti-Detection System

This app includes an **anti-detection system** to reduce the risk of WhatsApp detecting automation and logging you out. The system includes:

### Features

1. **Human-like Delays** - Random delays between messages (2-5 seconds by default)
2. **Message Queue** - Messages are queued and sent with proper spacing
3. **Pattern Detection** - Detects and prevents suspicious patterns (identical messages, rapid sending)
4. **Cooldown Periods** - Automatic cooldown after sending multiple messages
5. **Media Delays** - Extra delays for media files (they take longer to process)

### Configuration

You can customize anti-detection settings via environment variables:

```bash
# Minimum delay between messages (milliseconds)
MIN_MESSAGE_DELAY=2000

# Maximum delay between messages (milliseconds)
MAX_MESSAGE_DELAY=5000

# Cooldown period after multiple messages (milliseconds)
COOLDOWN_PERIOD=30000

# Maximum messages before cooldown
MAX_MESSAGES_BEFORE_COOLDOWN=5

# Media delay multiplier (media files get extra delay)
MEDIA_DELAY_MULTIPLIER=1.5
```

### How It Works

- Messages are automatically queued when you send them
- The system adds random delays between messages to simulate human behavior
- After sending 5 messages, a 30-second cooldown is automatically applied
- If suspicious patterns are detected (same message sent 3+ times, or 3+ messages to same recipient in 10 seconds), extra delays are added
- The queue position and status are shown in the API response

### Best Practices

1. **Don't send too many messages at once** - Even with anti-detection, sending 100+ messages quickly is risky
2. **Vary your messages** - Don't send identical messages repeatedly
3. **Use reasonable delays** - The default settings are conservative; don't reduce them too much
4. **Monitor the queue** - Check the `/status` endpoint to see queue status
5. **Respect rate limits** - The system limits to 10 messages per minute per IP

### Checking Queue Status

You can check the anti-detection system status via the `/status` endpoint:

```bash
curl http://localhost:3000/status
```

Response includes:
```json
{
  "ok": true,
  "ready": true,
  "antiDetection": {
    "queueLength": 2,
    "isProcessing": true,
    "messageCountInWindow": 3,
    "cooldownUntil": null,
    "config": {
      "minDelay": 2000,
      "maxDelay": 5000,
      "cooldownPeriod": 30000,
      "maxMessagesBeforeCooldown": 5,
      "mediaDelayMultiplier": 1.5
    }
  }
}
```

## License

ISC

