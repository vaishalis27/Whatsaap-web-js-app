// Optional API Key middleware for security
// To enable: uncomment the require and app.use lines in server.js

/**
 * API key authentication middleware
 * - When API_KEY is set: external API calls require X-API-Key; dashboard is allowed via whitelist or Referer/Origin.
 * - list-groups and list-contacts are whitelisted so the dashboard works when Referer/Origin are missing or normalized; for strict protection restrict by IP or reverse proxy.
 */
const DASHBOARD_PATHS = [
  '/status',
  '/api/health', '/api/qr', '/api/qr-image', '/api/qr-stream', '/api/force-qr', '/api/logout',
  '/list-groups', '/list-contacts'
];

function isDashboardPath(pathname) {
  const p = (pathname || '').split('?')[0];
  return DASHBOARD_PATHS.includes(p);
}

const apiKeyAuth = (req, res, next) => {
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    return next();
  }

  const pathname = (req.originalUrl || req.url || '').split('?')[0];

  // Dashboard paths: always allow without API key (restores pre-API behavior for the UI)
  if (isDashboardPath(pathname)) {
    return next();
  }

  // Same-origin (Referer/Origin host matches server host) – allow without key
  const serverHostRaw = (req.get('host') || '').toLowerCase().split(/\s/)[0];
  if (serverHostRaw) {
    const [serverHostname, serverPort] = serverHostRaw.includes(':') ? serverHostRaw.split(':') : [serverHostRaw, ''];
    const headerHostMatches = (urlString) => {
      if (!urlString || typeof urlString !== 'string') return false;
      try {
        const u = new URL(urlString);
        const refHost = (u.host || '').toLowerCase();
        if (refHost === serverHostRaw) return true;
        const refHostname = (u.hostname || '').toLowerCase();
        const refPort = u.port || (u.protocol === 'https:' ? '443' : '80');
        const sameHostname = refHostname === serverHostname;
        const samePort = !serverPort || refPort === serverPort;
        return sameHostname && samePort;
      } catch {
        return false;
      }
    };
    if (headerHostMatches(req.get('referer')) || headerHostMatches(req.get('origin'))) {
      return next();
    }
  }

  // All other requests (e.g. POST /send-group, /send-contact from another app) require X-API-Key
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

