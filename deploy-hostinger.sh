#!/bin/bash
# Hostinger VPS Deployment Script
# This script automates the deployment of WhatsApp Web.js API on Hostinger VPS
# 
# Usage: 
#   chmod +x deploy-hostinger.sh
#   ./deploy-hostinger.sh

set -e  # Exit on error

echo "========================================="
echo "WhatsApp Web.js API - Hostinger Deployment"
echo "========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored messages
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   print_error "This script should NOT be run as root"
   exit 1
fi

echo "Step 1: Updating system packages..."
sudo apt update && sudo apt upgrade -y
print_success "System packages updated"

echo ""
echo "Step 2: Installing Node.js 18 LTS..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt install -y nodejs
    print_success "Node.js installed"
else
    NODE_VERSION=$(node --version)
    print_warning "Node.js already installed: $NODE_VERSION"
fi

echo ""
echo "Step 3: Installing Chromium and dependencies..."
sudo apt install -y \
  chromium-browser \
  libgbm1 \
  libnss3 \
  libxss1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libdrm2 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm-dev \
  libgtk-3-0
print_success "Chromium and dependencies installed"

echo ""
echo "Step 4: Verifying Chromium installation..."
CHROMIUM_PATH=$(which chromium-browser)
if [ -z "$CHROMIUM_PATH" ]; then
    print_error "Chromium not found!"
    exit 1
else
    print_success "Chromium found at: $CHROMIUM_PATH"
fi

echo ""
echo "Step 5: Installing PM2 globally..."
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
    print_success "PM2 installed"
else
    print_warning "PM2 already installed"
fi

echo ""
echo "Step 6: Creating application directory..."
APP_DIR=~/apps/Whatsaap-web-js-app
if [ ! -d "$APP_DIR" ]; then
    mkdir -p ~/apps
    cd ~/apps
    
    echo "Cloning repository..."
    git clone https://github.com/vaishalis27/Whatsaap-web-js-app.git
    print_success "Repository cloned"
else
    print_warning "Application directory already exists"
    cd "$APP_DIR"
    
    echo "Pulling latest changes..."
    git pull origin main
    print_success "Repository updated"
fi

echo ""
echo "Step 7: Installing npm dependencies..."
cd "$APP_DIR"
npm ci
print_success "Dependencies installed"

echo ""
echo "Step 8: Configuring environment..."
if [ ! -f .env ]; then
    cp .env.example .env
    
    # Generate API key
    API_KEY=$(openssl rand -hex 32)
    
    # Update .env file
    sed -i "s/your-secure-random-api-key/$API_KEY/" .env
    sed -i "s|# PUPPETEER_EXECUTABLE_PATH=.*|PUPPETEER_EXECUTABLE_PATH=$CHROMIUM_PATH|" .env
    
    print_success "Environment file created"
    print_warning "IMPORTANT: Edit .env file and set your domain in ALLOWED_ORIGINS"
    print_warning "Your API_KEY: $API_KEY"
    print_warning "Save this key securely!"
else
    print_warning ".env file already exists, skipping creation"
fi

echo ""
echo "Step 9: Setting up PM2..."
# Stop existing instance if running
pm2 stop whatsapp-api 2>/dev/null || true

# Start application
pm2 start server.js --name whatsapp-api

# Save PM2 configuration
pm2 save

# Setup PM2 startup
print_warning "Setting up PM2 startup script..."
pm2 startup

print_success "PM2 configured"

echo ""
echo "Step 10: Configuring firewall (UFW)..."
if command -v ufw &> /dev/null; then
    sudo ufw allow 22/tcp  # SSH
    sudo ufw allow 80/tcp  # HTTP
    sudo ufw allow 443/tcp # HTTPS
    sudo ufw allow 4000/tcp # App port (if not using nginx)
    
    # Enable firewall (with confirmation)
    print_warning "Enabling firewall. Make sure SSH (port 22) is allowed!"
    sudo ufw --force enable
    print_success "Firewall configured"
else
    print_warning "UFW not found, skipping firewall configuration"
fi

echo ""
echo "Step 11: Creating swap space (2GB)..."
if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    
    # Make swap permanent
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    
    print_success "Swap space created (2GB)"
else
    print_warning "Swap file already exists"
fi

echo ""
echo "========================================="
echo "Deployment Complete! 🎉"
echo "========================================="
echo ""
echo "Next Steps:"
echo "1. Edit .env file and set your domain:"
echo "   nano $APP_DIR/.env"
echo ""
echo "2. Restart the application:"
echo "   pm2 restart whatsapp-api"
echo ""
echo "3. Access the dashboard:"
echo "   http://YOUR_VPS_IP:4000"
echo ""
echo "4. Check application status:"
echo "   pm2 status"
echo "   pm2 logs whatsapp-api"
echo ""
echo "5. (Optional) Set up nginx with SSL:"
echo "   See HOSTINGER_DEPLOYMENT.md for instructions"
echo ""
print_warning "Remember to scan the QR code on first run!"
echo ""
