// Optional API Key middleware for security
// To enable: uncomment the require and app.use lines in server.js

/**
 * API Key authentication middleware
 * Requires X-API-Key header to match process.env.API_KEY
 */
const apiKeyAuth = (req, res, next) => {
  const apiKey = process.env.API_KEY;
  
  // If no API_KEY is set, skip authentication (for development)
  if (!apiKey) {
    console.warn('⚠️  WARNING: API_KEY not set. API is open to anyone!');
    return next();
  }

  const providedKey = req.headers['x-api-key'];
  
  if (!providedKey) {
    return res.status(401).json({ 
      ok: false, 
      error: 'API key required. Provide X-API-Key header.' 
    });
  }

  if (providedKey !== apiKey) {
    return res.status(403).json({ 
      ok: false, 
      error: 'Invalid API key' 
    });
  }

  next();
};

module.exports = { apiKeyAuth };

