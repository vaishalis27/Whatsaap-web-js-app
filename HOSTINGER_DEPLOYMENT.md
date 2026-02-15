# Deploy on Hostinger VPS & Use from Another App

This guide covers deploying the WhatsApp API on a **Hostinger VPS** and calling it from another application (backend, script, or frontend).

---

## 1. Is the app ready for Hostinger?

| Requirement | Status |
|-------------|--------|
| **Node.js 18+** | ✅ Use LTS on VPS |
| **Chromium for Puppeteer** | ✅ Install on VPS or use env `PUPPETEER_EXECUTABLE_PATH` |
| **API key for external calls** | ✅ Set `API_KEY` in `.env`; other apps send `X-API-Key` |
| **CORS for other app's domain** | ✅ Set `ALLOWED_ORIGINS` to your app's origin(s) |
| **Process manager (PM2)** | ✅ Use PM2 so the app restarts on crash/reboot |
| **Port & firewall** | ✅ Open port (e.g. 4000) or use reverse proxy (nginx + SSL) |

---

## 2. Hostinger VPS setup

### 2.1 Install Node.js 18+ and Chromium

```bash
# Node 18 LTS (adjust for your OS; example for Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Chromium and dependencies for Puppeteer
sudo apt-get update
sudo apt-get install -y chromium-browser \
  libgbm1 libnss3 libxss1 libasound2 libatk-bridge2.0-0 \
  libdrm2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2
```

### 2.2 Optional: use system Chromium

If Puppeteer’s bundled Chromium fails, use the system one:

```bash
# In .env (path may vary: chromium-browser, google-chrome, etc.)
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

### 2.3 Install PM2

```bash
sudo npm install -g pm2
```

---

## 3. Deploy the app

```bash
# Clone or upload your project
cd /path/to/wtasappweb

# Install dependencies
npm ci

# Create .env (see below)
cp .env.example .env
nano .env

# Start with PM2
pm2 start server.js --name whatsapp-api
pm2 save
pm2 startup   # follow the command it prints so it runs on reboot
```

### 3.1 `.env` on Hostinger (production)

```env
PORT=4000
NODE_ENV=production

# Required for external apps; generate with: openssl rand -hex 32
API_KEY=your-secure-random-api-key

# Your dashboard domain and/or the domain of the app that will call this API (comma-separated)
ALLOWED_ORIGINS=https://your-hostinger-domain.com,https://your-other-app.com

# Optional if Chromium is not found
# PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

### 3.2 Open port and (recommended) HTTPS

- **Firewall:** Allow TCP port `4000` (or the port you use) if the app is bound to 0.0.0.0.
- **HTTPS:** Put **nginx** (or Caddy) in front, terminate SSL, and proxy to `http://127.0.0.1:4000`. Use Let’s Encrypt for the certificate.

---

## 4. Using the API from another app

Once the app is running on Hostinger (e.g. `https://api.yourdomain.com` or `http://YOUR_VPS_IP:4000`):

### 4.1 Authentication

- **From the same server (dashboard):** Open `https://your-domain.com/` in a browser; no API key needed.
- **From another app (different server/domain):** Send the API key on every request:

  ```
  X-API-Key: your-secure-random-api-key
  ```

### 4.2 Base URL

Use your public URL, for example:

- `https://api.yourdomain.com` (if you use a reverse proxy and path is `/`)
- `http://YOUR_VPS_IP:4000` (direct; prefer HTTPS in production)

### 4.3 Example: send message from another app

**cURL:**

```bash
curl -X POST https://api.yourdomain.com/send-contact \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-secure-random-api-key" \
  -d '{"phone":"1234567890","message":"Hello from my app"}'
```

**JavaScript (Node or browser):**

```javascript
const response = await fetch('https://api.yourdomain.com/send-contact', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.WHATSAPP_API_KEY  // store key in env
  },
  body: JSON.stringify({ phone: '1234567890', message: 'Hello' })
});
const data = await response.json();
```

**Python:**

```python
import requests

url = "https://api.yourdomain.com/send-contact"
headers = {
    "Content-Type": "application/json",
    "X-API-Key": "your-secure-random-api-key"
}
payload = {"phone": "1234567890", "message": "Hello"}
r = requests.post(url, json=payload, headers=headers)
```

### 4.4 CORS (if the other app is a browser frontend)

- Set `ALLOWED_ORIGINS` in `.env` to the exact origin(s) of the app that will call the API (e.g. `https://myapp.com`).
- The server already sends CORS headers; with `ALLOWED_ORIGINS` set, only those origins are allowed. Do not use `*` in production.

---

## 5. First run: link WhatsApp

1. Open the dashboard: `https://your-domain.com/` (or `http://YOUR_VPS_IP:4000/`).
2. Click **Show QR Code** and scan it with WhatsApp (Linked devices).
3. After that, the session is stored on the server; other apps can use the API without scanning again (until logout or session loss).

---

## 6. Checklist before going live

- [ ] `API_KEY` set in `.env` (strong random value).
- [ ] `ALLOWED_ORIGINS` set to your real domain(s), not `*`.
- [ ] App run with PM2 and `pm2 startup` configured.
- [ ] Port open in firewall (if not using reverse proxy only).
- [ ] HTTPS via nginx/Caddy (recommended).
- [ ] Other app uses base URL + `X-API-Key` for all requests.

For full API details (endpoints, request/response formats), see [API_DOCUMENTATION.md](./API_DOCUMENTATION.md).
