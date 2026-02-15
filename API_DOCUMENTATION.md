# WhatsApp Web API Documentation

This app provides a complete REST API for sending WhatsApp messages, managing groups, and monitoring the WhatsApp connection status.

## Base URL

- **Local:** `http://localhost:4000` (default port; set `PORT` in `.env` to override)
- **Production:** `https://your-domain.com` or `http://your-server-ip:4000` (use HTTPS via reverse proxy in production)

## Authentication

- **Dashboard (browser):** No API key needed when opening the app in a browser on the same server (e.g. `https://your-domain.com/`).
- **External apps (curl, Postman, your backend):** When `API_KEY` is set in `.env`, you **must** send the header `X-API-Key` with every request.

Add to your `.env`:
```bash
API_KEY=your-secure-random-api-key
```

Example from another app or curl:
```bash
curl -H "X-API-Key: your-secure-random-api-key" https://your-domain.com/status
```

### Testing from another app (before deployment)

To verify that external callers need the API key and that your key works, run the included test script **while the WhatsApp API is running** (e.g. in another terminal: `npm start`):

```bash
# Ensure .env has API_KEY set (same as the server)
node test-external-call.js
```

Optional: override base URL or API key:
```bash
node test-external-call.js http://localhost:4000
API_KEY=mykey node test-external-call.js
```

The script calls `/status` without and with `X-API-Key`. You should see 401 without the key (when `API_KEY` is set) and 200 with the key. To test from a real second app, run that app on another port (e.g. 3000) and have it call `http://localhost:4000` with the `X-API-Key` header.

## Rate Limiting

- **General API**: 100 requests per 15 minutes per IP
- **Message Sending**: 10 requests per minute per IP

## API Endpoints

### 1. Health Check

Check if the API server is running.

**Endpoint:** `GET /api/health`

**Response:**
```json
{
  "ok": true,
  "status": "running",
  "timestamp": 1234567890
}
```

**Example:**
```bash
curl http://localhost:4000/api/health
```

---

### 2. Get Status

Get the current WhatsApp connection status and anti-detection system metrics.

**Endpoint:** `GET /status`

**Response:**
```json
{
  "ok": true,
  "ready": true,
  "status": "connected",
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

**Example:**
```bash
curl http://localhost:4000/status
```

**Response Fields:**
- `ready`: `true` if WhatsApp is connected and ready to send messages
- `status`: Connection status (`"connected"`, `"connecting"`, `"disconnected"`)
- `antiDetection.queueLength`: Number of messages waiting in queue
- `antiDetection.isProcessing`: Whether a message is currently being sent
- `antiDetection.messageCountInWindow`: Messages sent in the current time window
- `antiDetection.cooldownUntil`: Timestamp when cooldown period ends (null if no cooldown)

---

### 3. List Groups

Get a list of all WhatsApp groups with their IDs and participant counts.

**Endpoint:** `GET /list-groups`

**Response:**
```json
{
  "ok": true,
  "groups": [
    {
      "id": "120363123456789012@g.us",
      "name": "My Group",
      "participants": 10
    },
    {
      "id": "120363987654321098@g.us",
      "name": "Another Group",
      "participants": 5
    }
  ],
  "count": 2
}
```

**Example:**
```bash
curl http://localhost:4000/list-groups
```

**Error Response:**
```json
{
  "ok": false,
  "error": "WhatsApp client not ready yet. Please wait for connection...",
  "reconnecting": false
}
```

---

### 4. List Contacts

Get a list of all personal contacts (individual chats, not groups).

**Endpoint:** `GET /list-contacts`

**Response:**
```json
{
  "ok": true,
  "contacts": [
    {
      "id": "1234567890@c.us",
      "name": "John Doe",
      "number": "1234567890"
    },
    {
      "id": "9876543210@c.us",
      "name": "Jane Smith",
      "number": "9876543210"
    }
  ],
  "count": 2
}
```

**Example:**
```bash
curl http://localhost:4000/list-contacts
```

**Note:** Only contacts with active chats (at least one message sent) will appear.

---

### 5. Send Message to Group

Send a text message or file to a WhatsApp group.

**Endpoint:** `POST /send-group`

**Content-Type:** `application/json` (for text) or `multipart/form-data` (for files)

**Request Body (Text Message):**
```json
{
  "groupId": "120363123456789012@g.us",
  "message": "Hello group!"
}
```

**Request Body (File Upload):**
```
Content-Type: multipart/form-data

groupId: 120363123456789012@g.us
message: Optional caption for the file
file: [binary file data]
```

**Response:**
```json
{
  "ok": true,
  "messageId": "3EB0123456789ABCDEF",
  "timestamp": 1234567890,
  "groupName": "My Group",
  "queuePosition": 1,
  "estimatedWaitTime": 3000
}
```

**Example (Text):**
```bash
curl -X POST http://localhost:4000/send-group \
  -H "Content-Type: application/json" \
  -d '{
    "groupId": "120363123456789012@g.us",
    "message": "Hello from API!"
  }'
```

**Example (File with cURL):**
```bash
curl -X POST http://localhost:4000/send-group \
  -F "groupId=120363123456789012@g.us" \
  -F "message=Check out this image!" \
  -F "file=@/path/to/image.jpg"
```

**Example (File with JavaScript/Fetch):**
```javascript
const formData = new FormData();
formData.append('groupId', '120363123456789012@g.us');
formData.append('message', 'Check out this image!');
formData.append('file', fileInput.files[0]);

fetch('http://localhost:4000/send-group', {
  method: 'POST',
  body: formData
})
.then(res => res.json())
.then(data => console.log(data));
```

**Supported File Types:**
- Images: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- Documents: `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- Videos: `video/mp4`, `video/avi`, `video/quicktime`
- Audio: `audio/mpeg`, `audio/wav`, `audio/ogg`

**Error Response:**
```json
{
  "ok": false,
  "error": "Invalid groupId format. Expected format: numbers-numbers@g.us"
}
```

---

### 6. Send Message to Contact

Send a text message or file to a personal contact.

**Endpoint:** `POST /send-contact`

**Content-Type:** `application/json` (for text) or `multipart/form-data` (for files)

**Request Body (Text Message):**
```json
{
  "contactId": "1234567890@c.us",
  "message": "Hello!"
}
```

**Request Body (File Upload):**
```
Content-Type: multipart/form-data

contactId: 1234567890@c.us
message: Optional caption for the file
file: [binary file data]
```

**Response:**
```json
{
  "ok": true,
  "messageId": "3EB0123456789ABCDEF",
  "timestamp": 1234567890,
  "contactName": "John Doe",
  "queuePosition": 1,
  "estimatedWaitTime": 3000
}
```

**Example (Text):**
```bash
curl -X POST http://localhost:4000/send-contact \
  -H "Content-Type: application/json" \
  -d '{
    "contactId": "1234567890@c.us",
    "message": "Hello from API!"
  }'
```

**Example (File):**
```bash
curl -X POST http://localhost:4000/send-contact \
  -F "contactId=1234567890@c.us" \
  -F "message=Check out this PDF!" \
  -F "file=@/path/to/document.pdf"
```

---

### 7. Reset & Validate List

Force a fresh fetch of groups and contacts from WhatsApp, removing invalid entries.

**Endpoint:** `POST /api/reset-list`

**Response:**
```json
{
  "ok": true,
  "groups": [...],
  "contacts": [...],
  "groupsCount": 5,
  "contactsCount": 10,
  "message": "List refreshed successfully"
}
```

**Example:**
```bash
curl -X POST http://localhost:4000/api/reset-list
```

---

### 8. Get QR Code (Base64)

Get the current QR code as a base64-encoded image for authentication.

**Endpoint:** `GET /api/qr`

**Response:**
```json
{
  "ok": true,
  "qr": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
}
```

**Example:**
```bash
curl http://localhost:4000/api/qr
```

**Note:** Only available when the client is in "QR code" state (not authenticated).

---

### 9. Get QR Code Stream (SSE)

Get the QR code as a Server-Sent Events (SSE) stream for real-time updates.

**Endpoint:** `GET /api/qr-stream`

**Response:** SSE stream with QR code updates

**Example (JavaScript):**
```javascript
const eventSource = new EventSource('http://localhost:4000/api/qr-stream');
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.qr) {
    document.getElementById('qr-image').src = data.qr;
  }
};
```

---

### 10. Logout

Log out from WhatsApp and clear the session.

**Endpoint:** `POST /api/logout`

**Response:**
```json
{
  "ok": true,
  "message": "Logged out successfully"
}
```

**Example:**
```bash
curl -X POST http://localhost:4000/api/logout
```

**Note:** After logout, you'll need to scan the QR code again to reconnect.

---

## Error Handling

All endpoints return errors in a consistent format:

```json
{
  "ok": false,
  "error": "Error message here"
}
```

**Common HTTP Status Codes:**
- `200` - Success
- `400` - Bad Request (invalid parameters)
- `401` - Unauthorized (if authentication is enabled)
- `429` - Too Many Requests (rate limit exceeded)
- `500` - Internal Server Error
- `503` - Service Unavailable (WhatsApp not ready, reconnecting, etc.)

---

## Message Queue System

Messages are automatically queued to prevent detection by WhatsApp. When you send a message:

1. It's added to a queue
2. The system waits for an appropriate delay (2-5 seconds by default)
3. The message is sent
4. A cooldown period may be applied after multiple messages

**Queue Information in Response:**
```json
{
  "ok": true,
  "messageId": "...",
  "queuePosition": 2,
  "estimatedWaitTime": 5000
}
```

---

## Complete API Examples

### Python Example

```python
import requests

BASE_URL = "http://localhost:4000"

# Check status
status = requests.get(f"{BASE_URL}/status").json()
print(f"Ready: {status['ready']}")

# List groups
groups = requests.get(f"{BASE_URL}/list-groups").json()
print(f"Found {groups['count']} groups")

# Send message to group
response = requests.post(
    f"{BASE_URL}/send-group",
    json={
        "groupId": groups['groups'][0]['id'],
        "message": "Hello from Python!"
    }
)
print(response.json())

# Send file to contact
with open('image.jpg', 'rb') as f:
    response = requests.post(
        f"{BASE_URL}/send-contact",
        files={'file': f},
        data={
            'contactId': '1234567890@c.us',
            'message': 'Check this out!'
        }
    )
print(response.json())
```

### Node.js Example

```javascript
const axios = require('axios');

const BASE_URL = 'http://localhost:4000';

async function sendMessage() {
  try {
    // Check status
    const status = await axios.get(`${BASE_URL}/status`);
    console.log('Ready:', status.data.ready);

    // List groups
    const groups = await axios.get(`${BASE_URL}/list-groups`);
    console.log(`Found ${groups.data.count} groups`);

    // Send message
    const response = await axios.post(`${BASE_URL}/send-group`, {
      groupId: groups.data.groups[0].id,
      message: 'Hello from Node.js!'
    });
    console.log('Message sent:', response.data);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

sendMessage();
```

### PHP Example

```php
<?php
$baseUrl = 'http://localhost:4000';

// Check status
$status = json_decode(file_get_contents("$baseUrl/status"), true);
echo "Ready: " . ($status['ready'] ? 'Yes' : 'No') . "\n";

// List groups
$groups = json_decode(file_get_contents("$baseUrl/list-groups"), true);
echo "Found {$groups['count']} groups\n";

// Send message
$ch = curl_init("$baseUrl/send-group");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
    'groupId' => $groups['groups'][0]['id'],
    'message' => 'Hello from PHP!'
]));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: application/json'
]);
$response = json_decode(curl_exec($ch), true);
curl_close($ch);
print_r($response);
?>
```

---

## Webhook Integration

You can integrate this API with webhooks from other services. Example:

```javascript
// Express.js webhook handler
app.post('/webhook', async (req, res) => {
  const { event, data } = req.body;
  
  if (event === 'new_order') {
    // Send WhatsApp notification
    await fetch('http://localhost:4000/send-group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId: 'YOUR_GROUP_ID@g.us',
        message: `New order received: ${data.orderId}`
      })
    });
  }
  
  res.json({ ok: true });
});
```

---

## Security Best Practices

1. **Enable Authentication**: Add API key or JWT authentication
2. **Use HTTPS**: Always use HTTPS in production
3. **Restrict Origins**: Configure CORS to only allow trusted domains
4. **Rate Limiting**: Already implemented, but adjust limits as needed
5. **Input Validation**: All inputs are validated, but review for your use case
6. **Firewall**: Restrict API access to specific IPs if possible

---

## Troubleshooting

### "WhatsApp client not ready"
- Wait for the client to connect (check `/status` endpoint)
- If stuck, try `/api/logout` and scan QR code again

### "Invalid groupId format"
- Group IDs must end with `@g.us`
- Contact IDs must end with `@c.us`
- Use `/list-groups` or `/list-contacts` to get valid IDs

### "Rate limit exceeded"
- Wait before sending more requests
- Current limit: 10 messages per minute per IP

### "Session closed"
- The WhatsApp session was disconnected
- The system will automatically reconnect
- Check `/status` to see reconnection status

---

## Support

For issues or questions:
1. Check the server logs for detailed error messages
2. Use the `/status` endpoint to check system health
3. Review the main README.md for setup instructions

