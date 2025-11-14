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
- ✅ Send messages to groups via HTTP API or dashboard
- ✅ Session persistence (no re-scan after initial QR)
- ✅ Health check and status endpoints
- ✅ Real-time activity logging

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

## API Endpoints

### Health Check
```bash
GET http://localhost:3000/api/health
```

### List Groups
```bash
GET http://localhost:3000/list-groups
```

Response:
```json
{
  "ok": true,
  "groups": [
    {
      "id": "123456789-123456789@g.us",
      "name": "My Group",
      "participants": 10
    }
  ],
  "count": 1
}
```

### Send Message to Group
```bash
POST http://localhost:3000/send-group
Content-Type: application/json

{
  "groupId": "123456789-123456789@g.us",
  "message": "Hello group!"
}
```

Response:
```json
{
  "ok": true,
  "id": "3EB0...",
  "timestamp": 1234567890,
  "groupName": "My Group"
}
```

### Get Status
```bash
GET http://localhost:3000/status
```

## Finding Group IDs

The easiest way is to use the `/list-groups` endpoint. It returns all groups with their IDs and names.

Alternatively:
1. Open the group chat on your phone
2. Go to "Group Info" → Invite → "Invite to group via link"
3. The link may contain group information, but the API endpoint is more reliable

## Server Deployment

### Requirements
- Node.js 16+
- Chrome/Chromium dependencies (for Puppeteer)
- On Linux servers, you may need:
  ```bash
  sudo apt-get install -y \
    chromium-browser \
    chromium-chromedriver
  ```

### Process Management
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

## License

ISC

