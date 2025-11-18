# Deployment Guide

## ⚠️ Why Vercel Won't Work

**Vercel is NOT suitable for this WhatsApp API** because:

1. **Serverless Functions Only**: Vercel runs serverless functions with execution time limits (10-60 seconds max)
2. **No Long-Running Processes**: This app needs a continuously running server to maintain the WhatsApp connection
3. **No Persistent File System**: Session data (`.wwebjs_auth/`) needs persistent storage
4. **No WebSocket Support**: WhatsApp Web.js requires WebSocket connections
5. **Puppeteer/Chrome Issues**: Browser automation doesn't work well in serverless environments
6. **Ephemeral Storage**: Uploaded files and session data would be lost

## ✅ Recommended Platforms

These platforms support long-running Node.js applications:

### 1. **Render** (100% FREE - Best for Free Tier) ⭐

**Why Render:**
- ✅ **100% FREE forever** (no credit card required)
- ✅ Persistent storage included
- ✅ Automatic HTTPS
- ✅ Easy GitHub integration
- ⚠️ Spins down after 15 min inactivity (wakes on request - slight delay)

**Deployment Steps:**

1. **The project already includes `render.yaml` and `Dockerfile`** - these are configured to install Chrome dependencies automatically.

2. **Deploy:**
   - Go to [render.com](https://render.com)
   - Sign up/login (no credit card needed)
   - Click "New" → "Web Service"
   - Connect your GitHub repository
   - Render will auto-detect the Dockerfile
   - Click "Create Web Service"

3. **Important Settings:**
   - **Auto-Deploy**: Enable to deploy on every push
   - **Health Check Path**: `/api/health`
   - **Build Command**: (Auto-detected from Dockerfile)
   - **Start Command**: (Auto-detected from Dockerfile)

4. **Get Your API URL:**
   - Render provides: `https://your-app.onrender.com`
   - Use this URL in your other projects

5. **Access QR Code:**
   - Visit: `https://your-app.onrender.com` to see the dashboard
   - First request may take 30-60 seconds (waking up)

**Pricing:** ✅ **100% FREE** - No credit card, no charges, forever free tier

**Note:** Service sleeps after 15 min inactivity but wakes automatically on first request.

**⚠️ Chrome Dependencies Fix:**
The included `Dockerfile` automatically installs all required Chrome/Chromium dependencies. If you see errors about missing libraries, make sure Render is using the Dockerfile (it should auto-detect it).

---

### 2. **Railway** (Easiest Setup - Credit-Based) ⭐

**Why Railway:**
- ✅ One-click deployment from GitHub
- ✅ Persistent storage included
- ✅ $5 credit/month (not truly free, but generous)
- ✅ Automatic HTTPS
- ✅ Environment variables support
- ✅ Built-in logs
- ✅ Never sleeps (always running)

**Deployment Steps:**

1. **Push to GitHub** (if not already):
   ```bash
   git add .
   git commit -m "Ready for deployment"
   git push origin main
   ```

2. **Deploy on Railway:**
   - Go to [railway.app](https://railway.app)
   - Sign up/login with GitHub
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Railway will auto-detect Node.js and deploy

3. **Configure Environment Variables:**
   - In Railway dashboard, go to "Variables"
   - Add if needed:
     ```
     PORT=3000
     NODE_ENV=production
     ```

4. **Get Your API URL:**
   - Railway provides a public URL like: `https://your-app.railway.app`
   - Use this URL in your other projects instead of `localhost:3000`

5. **Access QR Code:**
   - Check Railway logs to see QR code in terminal
   - Or visit: `https://your-app.railway.app` to see the dashboard

**Pricing:** $5 credit/month (enough for small apps, but charges apply after credit runs out)

---

### 3. **DigitalOcean App Platform**

**Why DigitalOcean:**
- ✅ Reliable and scalable
- ✅ Persistent storage
- ✅ Good performance

**Deployment Steps:**

1. **Create `app.yaml`**:
   ```yaml
   name: whatsapp-api
   services:
     - name: api
       github:
         repo: your-username/your-repo
         branch: main
       run_command: npm start
       environment_slug: node-js
       instance_count: 1
       instance_size_slug: basic-xxs
       envs:
         - key: NODE_ENV
           value: production
         - key: PORT
           value: 3000
   ```

2. **Deploy:**
   - Go to [DigitalOcean App Platform](https://www.digitalocean.com/products/app-platform)
   - Create new app from GitHub
   - Select your repository
   - Configure settings
   - Deploy

**Pricing:** Starts at $5/month

---

### 4. **AWS EC2 / Lightsail** (Most Control)

**Why AWS:**
- ✅ Full control over the server
- ✅ Persistent storage
- ✅ Scalable

**Deployment Steps:**

1. **Launch EC2 Instance:**
   - Ubuntu 22.04 LTS
   - t2.micro (free tier) or t3.small
   - Configure security group (open port 3000 or 80/443)

2. **SSH into Server:**
   ```bash
   ssh -i your-key.pem ubuntu@your-ec2-ip
   ```

3. **Install Dependencies:**
   ```bash
   # Update system
   sudo apt update && sudo apt upgrade -y
   
   # Install Node.js 18+
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt install -y nodejs
   
   # Install Chrome dependencies for Puppeteer
   sudo apt install -y \
     chromium-browser \
     chromium-chromedriver \
     fonts-liberation \
     libasound2 \
     libatk-bridge2.0-0 \
     libatk1.0-0 \
     libcups2 \
     libdbus-1-3 \
     libdrm2 \
     libgbm1 \
     libgtk-3-0 \
     libnspr4 \
     libnss3 \
     libxcomposite1 \
     libxdamage1 \
     libxfixes3 \
     libxrandr2 \
     xdg-utils
   ```

4. **Clone and Setup:**
   ```bash
   # Clone your repo
   git clone https://github.com/your-username/your-repo.git
   cd your-repo
   
   # Install dependencies
   npm install
   
   # Create .env file
   nano .env
   # Add: PORT=3000, NODE_ENV=production
   ```

5. **Use PM2 for Process Management:**
   ```bash
   # Install PM2
   sudo npm install -g pm2
   
   # Start app
   pm2 start server.js --name whatsapp-api
   
   # Save PM2 configuration
   pm2 save
   pm2 startup
   ```

6. **Setup Nginx (Optional - for HTTPS):**
   ```bash
   sudo apt install nginx
   sudo nano /etc/nginx/sites-available/whatsapp-api
   ```
   
   Add:
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```
   
   ```bash
   sudo ln -s /etc/nginx/sites-available/whatsapp-api /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

7. **Setup SSL with Let's Encrypt:**
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d your-domain.com
   ```

**Pricing:** EC2 free tier (t2.micro) for 12 months, then ~$10/month

---

### 5. **Heroku** (Legacy - Not Recommended)

⚠️ **Note:** Heroku removed free tier, but still works if you have a paid account.

**Deployment Steps:**

1. **Install Heroku CLI:**
   ```bash
   npm install -g heroku
   heroku login
   ```

2. **Create `Procfile`:**
   ```
   web: node server.js
   ```

3. **Deploy:**
   ```bash
   heroku create your-app-name
   git push heroku main
   heroku open
   ```

**Pricing:** Starts at $7/month

---

## Environment Variables for Production

Create a `.env` file or set in platform dashboard:

```env
# Server Configuration
PORT=3000
NODE_ENV=production

# Optional: API Key for authentication
API_KEY=your-secret-api-key-here

# Optional: CORS origins (comma-separated)
ALLOWED_ORIGINS=https://your-frontend.com,https://another-domain.com

# Optional: Anti-detection settings
MIN_MESSAGE_DELAY=2000
MAX_MESSAGE_DELAY=5000
COOLDOWN_PERIOD=30000
MAX_MESSAGES_BEFORE_COOLDOWN=5
MEDIA_DELAY_MULTIPLIER=1.5
```

---

## Important Considerations

### 1. **Session Persistence**

The WhatsApp session is stored in `.wwebjs_auth/` folder. Make sure your platform:
- ✅ Has persistent storage (not ephemeral)
- ✅ Preserves files between deployments
- ✅ Doesn't clear the folder on restart

**Railway/Render:** ✅ Persistent by default
**Vercel:** ❌ Ephemeral (won't work)

### 2. **File Uploads**

Uploaded files are stored in `uploads/` folder. Consider:
- Using cloud storage (AWS S3, Cloudinary) for production
- Cleaning up old files periodically
- Setting up file size limits

### 3. **QR Code Access**

After deployment, you need to scan the QR code:
- Check platform logs for QR code
- Or visit the dashboard URL to see QR code
- Session persists after first scan

### 4. **HTTPS**

Always use HTTPS in production:
- Railway/Render: Automatic HTTPS
- AWS: Use Nginx + Let's Encrypt
- Update CORS settings to allow your HTTPS domain

### 5. **Security**

Before deploying to production:

1. **Add API Authentication:**
   ```javascript
   // In server.js, add before routes:
   const API_KEY = process.env.API_KEY;
   
   app.use((req, res, next) => {
     // Skip auth for health check and dashboard
     if (req.path === '/api/health' || req.path === '/') {
       return next();
     }
     
     const apiKey = req.headers['x-api-key'];
     if (!API_KEY || apiKey === API_KEY) {
       return next();
     }
     
     return res.status(401).json({ ok: false, error: 'Unauthorized' });
   });
   ```

2. **Restrict CORS:**
   ```env
   ALLOWED_ORIGINS=https://your-frontend.com
   ```

3. **Use Environment Variables:**
   - Never commit `.env` file
   - Use platform's environment variable settings

---

## Testing Your Deployment

After deployment, test your API:

```bash
# Check health
curl https://your-app.railway.app/api/health

# Check status
curl https://your-app.railway.app/status

# List groups
curl https://your-app.railway.app/list-groups

# Send message (with API key if enabled)
curl -X POST https://your-app.railway.app/send-group \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "groupId": "YOUR_GROUP_ID@g.us",
    "message": "Hello from production!"
  }'
```

---

## Updating Your Other Projects

Once deployed, update your other projects to use the production URL:

**Before (Local):**
```javascript
const API_URL = 'http://localhost:3000';
```

**After (Production):**
```javascript
const API_URL = process.env.WHATSAPP_API_URL || 'https://your-app.railway.app';
```

Or in `.env`:
```env
WHATSAPP_API_URL=https://your-app.railway.app
WHATSAPP_API_KEY=your-api-key-here
```

---

## Monitoring & Logs

### Railway
- View logs in Railway dashboard
- Real-time log streaming
- Automatic log retention

### Render
- View logs in Render dashboard
- Real-time log streaming

### AWS EC2
```bash
# View PM2 logs
pm2 logs whatsapp-api

# View system logs
sudo journalctl -u your-service -f
```

---

## Troubleshooting Deployment

### "Failed to launch the browser process" / "libgobject-2.0.so.0: cannot open shared object file"

**This is a Chrome dependencies issue. Solutions:**

1. **For Render (Dockerfile method - RECOMMENDED):**
   - Make sure `Dockerfile` is in your project root
   - Render should auto-detect it
   - The Dockerfile installs all required Chrome dependencies
   - If still failing, check Render logs to ensure Dockerfile is being used

2. **For Render (Alternative - if Dockerfile doesn't work):**
   - Go to Render dashboard → Your Service → Settings
   - Under "Build Command", change to:
     ```bash
     apt-get update && apt-get install -y libgobject-2.0-0 libgtk-3-0 libgbm1 libnss3 libxss1 libasound2 libatk-bridge2.0-0 libdrm2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 libxshmfence1 fonts-liberation libappindicator3-1 xdg-utils && npm install
     ```
   - Note: This might not work on free tier (no sudo access)

3. **For Railway:**
   - Railway usually handles this automatically
   - If issues persist, add to `railway.json` or use Nixpacks

4. **For AWS EC2/VPS:**
   - See the AWS EC2 section above for full dependency installation commands

### "WhatsApp client not ready"
- Check logs for QR code
- Scan QR code to authenticate
- Wait for connection to establish

### "Chrome/Chromium not found"
- Install Chrome dependencies (see AWS EC2 section)
- Set `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false` in environment

### "Port already in use"
- Set `PORT` environment variable
- Platform should auto-assign port

### "Session lost after deployment"
- Ensure persistent storage is enabled
- Don't delete `.wwebjs_auth/` folder
- Re-scan QR code if needed

---

## Quick Comparison

| Platform | Free Tier | Ease of Use | Best For |
|----------|-----------|-------------|----------|
| **Render** | ✅ **100% FREE** | ⭐⭐⭐⭐ | Best free option |
| **Railway** | ⚠️ $5 credit/month | ⭐⭐⭐⭐⭐ | Quick deployment (credit-based) |
| **AWS EC2** | ✅ 12 months free | ⭐⭐ | Full control |
| **DigitalOcean** | ❌ | ⭐⭐⭐ | Production apps |
| **Vercel** | ❌ | ❌ | Won't work |

---

## Recommendation

**For FREE deployment: Use Render** - 100% free forever, no credit card needed, perfect for testing and small projects.

**For always-on service: Use Railway** - $5 credit/month, never sleeps, easiest setup.

**For production: Use DigitalOcean or AWS EC2** - more control and better for scaling.

---

## Need Help?

1. Check platform-specific documentation
2. Review server logs for errors
3. Test locally first before deploying
4. Use `/api/health` endpoint to verify deployment

