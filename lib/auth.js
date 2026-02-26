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
  } catch (e) {
    return res.status(401).json({ message: 'Unauthorized: invalid credentials' });
  }

  var colonIndex = decoded.indexOf(':');
  if (colonIndex === -1) {
    return res.status(401).json({ message: 'Unauthorized: invalid credentials' });
  }

  var password = decoded.slice(colonIndex + 1);
  if (password !== config.proxyApiKey) {
    return res.status(401).json({ message: 'Unauthorized: invalid API key' });
  }

  next();
}

module.exports = authMiddleware;
