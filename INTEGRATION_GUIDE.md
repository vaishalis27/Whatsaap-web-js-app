# Integration Guide: Using WhatsApp API in Other Projects

This guide shows you how to integrate the WhatsApp Web API into your other projects, whether you're using Node.js, Python, React, or any other language/framework.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Setting Up the WhatsApp API Service](#setting-up-the-whatsapp-api-service)
3. [Integration Examples](#integration-examples)
4. [Using in Cursor](#using-in-cursor)
5. [Best Practices](#best-practices)
6. [Troubleshooting](#troubleshooting)

---

## Prerequisites

1. **WhatsApp API Service Running**: The WhatsApp API server must be running and accessible
2. **Base URL**: Know the base URL where your API is running (default: `http://localhost:3000`)
3. **WhatsApp Connected**: Ensure WhatsApp is connected (check `/status` endpoint)

---

## Setting Up the WhatsApp API Service

### Step 1: Start the WhatsApp API Server

In your WhatsApp API project directory:

```bash
cd "D:\My projects\wtasappweb"
npm start
```

The server will start on `http://localhost:3000` (or the port specified in your `.env` file).

### Step 2: Verify It's Running

```bash
# Check health
curl http://localhost:3000/api/health

# Check WhatsApp status
curl http://localhost:3000/status
```

You should see:
```json
{
  "ok": true,
  "ready": true,
  "status": "connected"
}
```

### Step 3: Get Your Group/Contact IDs

```bash
# List groups
curl http://localhost:3000/list-groups

# List contacts
curl http://localhost:3000/list-contacts
```

Save the IDs you need (they look like `120363123456789012@g.us` for groups or `1234567890@c.us` for contacts).

---

## Integration Examples

### Node.js / Express.js Project

#### 1. Install HTTP Client Library

```bash
npm install axios
# or
npm install node-fetch
```

#### 2. Create API Client Module

Create `whatsapp-api-client.js`:

```javascript
const axios = require('axios');

class WhatsAppAPIClient {
  constructor(baseURL = 'http://localhost:3000') {
    this.baseURL = baseURL;
  }

  async checkStatus() {
    const response = await axios.get(`${this.baseURL}/status`);
    return response.data;
  }

  async listGroups() {
    const response = await axios.get(`${this.baseURL}/list-groups`);
    return response.data;
  }

  async listContacts() {
    const response = await axios.get(`${this.baseURL}/list-contacts`);
    return response.data;
  }

  async sendToGroup(groupId, message, filePath = null) {
    if (filePath) {
      const FormData = require('form-data');
      const fs = require('fs');
      const form = new FormData();
      form.append('groupId', groupId);
      form.append('message', message || '');
      form.append('file', fs.createReadStream(filePath));
      
      const response = await axios.post(`${this.baseURL}/send-group`, form, {
        headers: form.getHeaders()
      });
      return response.data;
    } else {
      const response = await axios.post(`${this.baseURL}/send-group`, {
        groupId,
        message
      });
      return response.data;
    }
  }

  async sendToContact(contactId, message, filePath = null) {
    if (filePath) {
      const FormData = require('form-data');
      const fs = require('fs');
      const form = new FormData();
      form.append('contactId', contactId);
      form.append('message', message || '');
      form.append('file', fs.createReadStream(filePath));
      
      const response = await axios.post(`${this.baseURL}/send-contact`, form, {
        headers: form.getHeaders()
      });
      return response.data;
    } else {
      const response = await axios.post(`${this.baseURL}/send-contact`, {
        contactId,
        message
      });
      return response.data;
    }
  }
}

module.exports = WhatsAppAPIClient;
```

#### 3. Use in Your Express App

```javascript
const express = require('express');
const WhatsAppAPIClient = require('./whatsapp-api-client');

const app = express();
app.use(express.json());

const whatsapp = new WhatsAppAPIClient('http://localhost:3000');

// Example: Send notification when order is created
app.post('/api/orders', async (req, res) => {
  const { orderId, customerName } = req.body;
  
  try {
    // Send WhatsApp notification
    const result = await whatsapp.sendToGroup(
      'YOUR_GROUP_ID@g.us',
      `New order #${orderId} from ${customerName}!`
    );
    
    res.json({ 
      ok: true, 
      orderId,
      whatsappMessageId: result.messageId 
    });
  } catch (error) {
    console.error('WhatsApp error:', error.message);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

app.listen(3001, () => {
  console.log('Your app running on http://localhost:3001');
});
```

---

### Python / Flask / Django Project

#### 1. Install HTTP Client Library

```bash
pip install requests
```

#### 2. Create API Client Module

Create `whatsapp_api_client.py`:

```python
import requests
from typing import Optional

class WhatsAppAPIClient:
    def __init__(self, base_url: str = "http://localhost:3000"):
        self.base_url = base_url
    
    def check_status(self) -> dict:
        """Check WhatsApp connection status"""
        response = requests.get(f"{self.base_url}/status")
        return response.json()
    
    def list_groups(self) -> dict:
        """Get list of all groups"""
        response = requests.get(f"{self.base_url}/list-groups")
        return response.json()
    
    def list_contacts(self) -> dict:
        """Get list of all contacts"""
        response = requests.get(f"{self.base_url}/list-contacts")
        return response.json()
    
    def send_to_group(self, group_id: str, message: str, file_path: Optional[str] = None) -> dict:
        """Send message to group"""
        if file_path:
            with open(file_path, 'rb') as f:
                files = {'file': f}
                data = {'groupId': group_id, 'message': message}
                response = requests.post(f"{self.base_url}/send-group", files=files, data=data)
        else:
            response = requests.post(
                f"{self.base_url}/send-group",
                json={'groupId': group_id, 'message': message}
            )
        return response.json()
    
    def send_to_contact(self, contact_id: str, message: str, file_path: Optional[str] = None) -> dict:
        """Send message to contact"""
        if file_path:
            with open(file_path, 'rb') as f:
                files = {'file': f}
                data = {'contactId': contact_id, 'message': message}
                response = requests.post(f"{self.base_url}/send-contact", files=files, data=data)
        else:
            response = requests.post(
                f"{self.base_url}/send-contact",
                json={'contactId': contact_id, 'message': message}
            )
        return response.json()
```

#### 3. Use in Your Flask App

```python
from flask import Flask, request, jsonify
from whatsapp_api_client import WhatsAppAPIClient

app = Flask(__name__)
whatsapp = WhatsAppAPIClient('http://localhost:3000')

@app.route('/api/notify', methods=['POST'])
def send_notification():
    data = request.json
    group_id = data.get('groupId')
    message = data.get('message')
    
    try:
        result = whatsapp.send_to_group(group_id, message)
        return jsonify({
            'ok': True,
            'whatsappMessageId': result.get('messageId')
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(port=5000)
```

---

### React / Next.js / Frontend Project

#### 1. Create API Service

Create `src/services/whatsappApi.js`:

```javascript
const API_BASE_URL = process.env.REACT_APP_WHATSAPP_API_URL || 'http://localhost:3000';

export const whatsappApi = {
  async checkStatus() {
    const response = await fetch(`${API_BASE_URL}/status`);
    return await response.json();
  },

  async listGroups() {
    const response = await fetch(`${API_BASE_URL}/list-groups`);
    return await response.json();
  },

  async listContacts() {
    const response = await fetch(`${API_BASE_URL}/list-contacts`);
    return await response.json();
  },

  async sendToGroup(groupId, message, file = null) {
    if (file) {
      const formData = new FormData();
      formData.append('groupId', groupId);
      formData.append('message', message || '');
      formData.append('file', file);
      
      const response = await fetch(`${API_BASE_URL}/send-group`, {
        method: 'POST',
        body: formData
      });
      return await response.json();
    } else {
      const response = await fetch(`${API_BASE_URL}/send-group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, message })
      });
      return await response.json();
    }
  },

  async sendToContact(contactId, message, file = null) {
    if (file) {
      const formData = new FormData();
      formData.append('contactId', contactId);
      formData.append('message', message || '');
      formData.append('file', file);
      
      const response = await fetch(`${API_BASE_URL}/send-contact`, {
        method: 'POST',
        body: formData
      });
      return await response.json();
    } else {
      const response = await fetch(`${API_BASE_URL}/send-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, message })
      });
      return await response.json();
    }
  }
};
```

#### 2. Use in React Component

```javascript
import React, { useState, useEffect } from 'react';
import { whatsappApi } from './services/whatsappApi';

function NotificationButton() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    const data = await whatsappApi.checkStatus();
    setStatus(data);
  };

  const sendNotification = async () => {
    setLoading(true);
    try {
      const result = await whatsappApi.sendToGroup(
        'YOUR_GROUP_ID@g.us',
        'Hello from React!'
      );
      alert('Message sent! ID: ' + result.messageId);
    } catch (error) {
      alert('Error: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <p>Status: {status?.ready ? 'Connected' : 'Disconnected'}</p>
      <button onClick={sendNotification} disabled={loading}>
        {loading ? 'Sending...' : 'Send Notification'}
      </button>
    </div>
  );
}

export default NotificationButton;
```

---

### PHP Project

#### 1. Create API Client Class

Create `WhatsAppAPIClient.php`:

```php
<?php
class WhatsAppAPIClient {
    private $baseUrl;
    
    public function __construct($baseUrl = 'http://localhost:3000') {
        $this->baseUrl = $baseUrl;
    }
    
    public function checkStatus() {
        return json_decode(file_get_contents("{$this->baseUrl}/status"), true);
    }
    
    public function listGroups() {
        return json_decode(file_get_contents("{$this->baseUrl}/list-groups"), true);
    }
    
    public function sendToGroup($groupId, $message, $filePath = null) {
        $ch = curl_init("{$this->baseUrl}/send-group");
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        
        if ($filePath && file_exists($filePath)) {
            $cfile = new CURLFile($filePath);
            curl_setopt($ch, CURLOPT_POSTFIELDS, [
                'groupId' => $groupId,
                'message' => $message,
                'file' => $cfile
            ]);
        } else {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
                'groupId' => $groupId,
                'message' => $message
            ]));
            curl_setopt($ch, CURLOPT_HTTPHEADER, [
                'Content-Type: application/json'
            ]);
        }
        
        $response = curl_exec($ch);
        curl_close($ch);
        return json_decode($response, true);
    }
}
?>
```

#### 2. Use in Your PHP Script

```php
<?php
require_once 'WhatsAppAPIClient.php';

$whatsapp = new WhatsAppAPIClient('http://localhost:3000');

// Send notification
$result = $whatsapp->sendToGroup(
    'YOUR_GROUP_ID@g.us',
    'Hello from PHP!'
);

if ($result['ok']) {
    echo "Message sent! ID: " . $result['messageId'];
} else {
    echo "Error: " . $result['error'];
}
?>
```

---

## Using in Cursor

### Step 1: Open Your Other Project in Cursor

1. Open Cursor
2. File → Open Folder → Select your other project directory

### Step 2: Tell Cursor About the API

Create a `.cursorrules` file in your project root (or add to existing one):

```
# WhatsApp API Integration

The WhatsApp API service is running at: http://localhost:3000

Available endpoints:
- GET /status - Check connection status
- GET /list-groups - List all groups
- GET /list-contacts - List all contacts
- POST /send-group - Send message to group
- POST /send-contact - Send message to contact

Base URL: http://localhost:3000
Content-Type: application/json (for text) or multipart/form-data (for files)

Example group ID format: 120363123456789012@g.us
Example contact ID format: 1234567890@c.us
```

### Step 3: Create API Client in Your Project

Ask Cursor:

> "Create a WhatsApp API client module for [your language] that connects to http://localhost:3000"

Or use one of the examples above and ask Cursor to adapt it to your project structure.

### Step 4: Use the API Client

In your code, you can now use the API client:

```javascript
// Example: In your Node.js project
const whatsapp = require('./whatsapp-api-client');

// Send notification
whatsapp.sendToGroup('GROUP_ID@g.us', 'Hello!')
  .then(result => console.log('Sent:', result))
  .catch(error => console.error('Error:', error));
```

---

## Environment Variables

### For Your Other Project

Create a `.env` file in your other project:

```env
# WhatsApp API Configuration
WHATSAPP_API_URL=http://localhost:3000
WHATSAPP_GROUP_ID=120363123456789012@g.us
WHATSAPP_CONTACT_ID=1234567890@c.us

# Optional: API Key (if you add authentication)
WHATSAPP_API_KEY=your-api-key-here
```

### Loading Environment Variables

**Node.js:**
```bash
npm install dotenv
```

```javascript
require('dotenv').config();
const API_URL = process.env.WHATSAPP_API_URL;
```

**Python:**
```bash
pip install python-dotenv
```

```python
from dotenv import load_dotenv
import os

load_dotenv()
API_URL = os.getenv('WHATSAPP_API_URL')
```

---

## Best Practices

### 1. Error Handling

Always handle errors gracefully:

```javascript
try {
  const result = await whatsapp.sendToGroup(groupId, message);
  if (result.ok) {
    console.log('Success:', result.messageId);
  } else {
    console.error('API Error:', result.error);
  }
} catch (error) {
  console.error('Network Error:', error.message);
  // Retry logic, fallback, etc.
}
```

### 2. Check Status Before Sending

```javascript
// Check if WhatsApp is ready before sending
const status = await whatsapp.checkStatus();
if (!status.ready) {
  throw new Error('WhatsApp is not connected');
}
```

### 3. Queue Management

The API automatically queues messages, but you can check queue status:

```javascript
const status = await whatsapp.checkStatus();
if (status.antiDetection.queueLength > 10) {
  console.warn('Queue is long, messages may be delayed');
}
```

### 4. Retry Logic

Implement retry logic for failed requests:

```javascript
async function sendWithRetry(groupId, message, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await whatsapp.sendToGroup(groupId, message);
      if (result.ok) return result;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}
```

### 5. Rate Limiting

Respect the API's rate limits:
- **General API**: 100 requests per 15 minutes
- **Message Sending**: 10 messages per minute

Implement client-side rate limiting if needed:

```javascript
class RateLimitedClient {
  constructor() {
    this.lastSent = 0;
    this.minInterval = 6000; // 6 seconds between messages
  }

  async sendToGroup(groupId, message) {
    const now = Date.now();
    const timeSinceLastSent = now - this.lastSent;
    
    if (timeSinceLastSent < this.minInterval) {
      await new Promise(resolve => 
        setTimeout(resolve, this.minInterval - timeSinceLastSent)
      );
    }
    
    this.lastSent = Date.now();
    return await whatsapp.sendToGroup(groupId, message);
  }
}
```

---

## Troubleshooting

### "Connection Refused" Error

**Problem:** Can't connect to `http://localhost:3000`

**Solutions:**
1. Make sure the WhatsApp API server is running
2. Check if the port is correct (default: 3000)
3. If running on different machine, use the machine's IP address instead of `localhost`
4. Check firewall settings

### "WhatsApp client not ready" Error

**Problem:** API returns `ready: false`

**Solutions:**
1. Check the WhatsApp API server logs
2. Ensure WhatsApp is connected (scan QR code if needed)
3. Wait a few seconds and check `/status` again
4. Try `/api/logout` and reconnect

### CORS Errors (Frontend)

**Problem:** Browser blocks requests due to CORS

**Solutions:**
1. The API already has CORS enabled, but if you still get errors:
2. Make sure you're using the correct base URL
3. Check browser console for specific CORS error
4. If needed, update CORS settings in `server.js`

### Rate Limit Exceeded

**Problem:** Getting 429 errors

**Solutions:**
1. Wait before sending more requests
2. Implement client-side rate limiting (see Best Practices)
3. Reduce the frequency of API calls
4. Use the queue system - messages are automatically queued

### File Upload Issues

**Problem:** File uploads fail

**Solutions:**
1. Check file size (max 100MB)
2. Verify file type is allowed (images, PDFs, documents, videos, audio)
3. Make sure you're using `multipart/form-data` (not JSON)
4. Check file path is correct

---

## Production Deployment

### Running Both Services

1. **WhatsApp API Service**: Run on one server/port (e.g., `http://api.example.com:3000`)
2. **Your Other Project**: Run on another server/port (e.g., `http://app.example.com`)

### Security Considerations

1. **Add Authentication**: Add API key authentication to WhatsApp API
2. **Use HTTPS**: Always use HTTPS in production
3. **Restrict CORS**: Update CORS settings to only allow your domain
4. **Firewall**: Restrict WhatsApp API access to specific IPs if possible
5. **Environment Variables**: Never commit API keys or sensitive data

### Example Production Setup

```javascript
// Production configuration
const API_URL = process.env.NODE_ENV === 'production'
  ? 'https://whatsapp-api.yourdomain.com'
  : 'http://localhost:3000';

const API_KEY = process.env.WHATSAPP_API_KEY;

// Include API key in requests
const response = await fetch(`${API_URL}/send-group`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY
  },
  body: JSON.stringify({ groupId, message })
});
```

---

## Quick Reference

### Base URL
```
http://localhost:3000
```

### Key Endpoints
- `GET /status` - Check connection
- `GET /list-groups` - Get groups
- `GET /list-contacts` - Get contacts
- `POST /send-group` - Send to group
- `POST /send-contact` - Send to contact

### Request Format (Text)
```json
{
  "groupId": "120363123456789012@g.us",
  "message": "Hello!"
}
```

### Request Format (File)
```
Content-Type: multipart/form-data
groupId: 120363123456789012@g.us
message: Optional caption
file: [binary data]
```

### Response Format
```json
{
  "ok": true,
  "messageId": "3EB0123456789ABCDEF",
  "timestamp": 1234567890,
  "groupName": "My Group"
}
```

---

## Need Help?

1. Check the [API Documentation](./API_DOCUMENTATION.md) for detailed endpoint information
2. Review the [README](./README.md) for setup instructions
3. Check server logs for detailed error messages
4. Use the `/status` endpoint to diagnose connection issues

