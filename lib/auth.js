var crypto = require('crypto');
var config = require('./config');

// Ghost sends: Authorization: Basic base64("api:" + apiKey)
// mailgun.js uses username "api" and the API key as password

function authMiddleware(req, res, next) {
  var authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ message: 'Unauthorized: missing credentials' });
  }

  var decoded;
  try {
    decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  } catch (_e) {
    return res.status(401).json({ message: 'Unauthorized: invalid credentials' });
  }

  var colonIndex = decoded.indexOf(':');
  if (colonIndex === -1) {
    return res.status(401).json({ message: 'Unauthorized: invalid credentials' });
  }

  var password = decoded.slice(colonIndex + 1);
  var a = Buffer.from(password);
  var b = Buffer.from(config.proxyApiKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ message: 'Unauthorized: invalid API key' });
  }

  next();
}

module.exports = authMiddleware;
