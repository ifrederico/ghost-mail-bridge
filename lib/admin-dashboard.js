var express = require('express');
var fs = require('fs');
var path = require('path');
var config = require('./config');
var { db } = require('./db');

var countMessageMap = db.prepare('SELECT COUNT(*) as c FROM message_map');
var countRecipientEmails = db.prepare('SELECT COUNT(*) as c FROM recipient_emails');
var countEvents = db.prepare('SELECT COUNT(*) as c FROM events');
var countSuppressions = db.prepare('SELECT COUNT(*) as c FROM suppressions');
var countSentSince = db.prepare("SELECT COUNT(*) as c FROM recipient_emails WHERE created_at >= datetime('now', ?)");
var countEventTypeSince = db.prepare('SELECT COUNT(*) as c FROM events WHERE event_type = ? AND timestamp >= ?');
var countSuppressionType = db.prepare('SELECT COUNT(*) as c FROM suppressions WHERE type = ?');
var recentFailures = db.prepare(
  'SELECT id, event_type, severity, recipient, timestamp, message_id, email_id,' +
  ' delivery_status_code, delivery_status_message, delivery_status_enhanced' +
  ' FROM events WHERE event_type IN (?, ?) ORDER BY timestamp DESC, id DESC LIMIT ?'
);
var listSuppressions = db.prepare(
  'SELECT email, type, reason, created_at FROM suppressions ORDER BY created_at DESC LIMIT ?'
);

var dashboardAssetsDir = path.join(__dirname, 'admin-dashboard-assets');
var dashboardIndexPath = path.join(dashboardAssetsDir, 'index.html');
var dashboardStylesPath = path.join(dashboardAssetsDir, 'styles.css');
var dashboardAppPath = path.join(dashboardAssetsDir, 'app.js');
var dashboardTestDataPath = path.join(dashboardAssetsDir, 'test-data.json');

function parseLimit(value, fallback, max) {
  var parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function buildGhostBaseUrl() {
  if (!config.ghostAdminUrl) return null;
  return config.ghostAdminUrl.replace(/\/+$/, '');
}

function buildGhostAdminSiteUrl() {
  var base = buildGhostBaseUrl();
  if (!base) return null;
  return base + '/ghost/api/admin/site/';
}

function buildSigninUrl() {
  var base = buildGhostBaseUrl();
  if (!base) return '/ghost/#/signin';
  return base + '/ghost/#/signin';
}

function isBrowserHtmlRequest(req) {
  var accept = req.headers.accept || '';
  return accept.indexOf('text/html') !== -1;
}

async function verifyGhostSession(req) {
  var siteUrl = buildGhostAdminSiteUrl();
  if (!siteUrl) return false;

  var cookie = req.headers.cookie;
  if (!cookie) return false;

  var controller = new AbortController();
  var timeout = setTimeout(function() {
    controller.abort();
  }, 5000);

  try {
    var response = await fetch(siteUrl, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        'Accept-Version': config.ghostAcceptVersion
      },
      redirect: 'manual',
      signal: controller.signal
    });

    return response.status >= 200 && response.status < 300;
  } catch (_err) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function unauthorized(req, res, message) {
  if (isBrowserHtmlRequest(req)) {
    return res.redirect(302, buildSigninUrl());
  }

  return res.status(401).json({ message: message || 'Unauthorized' });
}

function createAdminAuthMiddleware() {
  return function(req, res, next) {
    if (!config.ghostAdminUrl) {
      return res.status(503).json({
        message: 'Server misconfigured: set GHOST_ADMIN_URL'
      });
    }

    verifyGhostSession(req).then(function(ok) {
      if (ok) return next();
      return unauthorized(req, res, 'Unauthorized: Ghost admin session required');
    }).catch(function() {
      return unauthorized(req, res, 'Unauthorized: session verification failed');
    });
  };
}

function getTableCounts() {
  return {
    message_map: countMessageMap.get().c,
    recipient_emails: countRecipientEmails.get().c,
    events: countEvents.get().c,
    suppressions: countSuppressions.get().c
  };
}

function getSummary() {
  var now = Math.floor(Date.now() / 1000);
  var since24h = now - 86400;

  return {
    sent_24h: countSentSince.get('-24 hours').c,
    delivered_24h: countEventTypeSince.get('delivered', since24h).c,
    opened_24h: countEventTypeSince.get('opened', since24h).c,
    clicked_24h: countEventTypeSince.get('clicked', since24h).c,
    failed_24h: countEventTypeSince.get('failed', since24h).c,
    complained_24h: countEventTypeSince.get('complained', since24h).c,
    suppressions: {
      bounces: countSuppressionType.get('bounces').c,
      complaints: countSuppressionType.get('complaints').c,
      unsubscribes: countSuppressionType.get('unsubscribes').c
    }
  };
}

function getRecentFailures(limit) {
  return recentFailures.all('failed', 'complained', limit).map(function(row) {
    return {
      id: row.id,
      event: row.event_type,
      severity: row.severity,
      recipient: row.recipient,
      timestamp: row.timestamp,
      message_id: row.message_id,
      email_id: row.email_id,
      code: row.delivery_status_code,
      reason: row.delivery_status_message,
      enhanced_code: row.delivery_status_enhanced
    };
  });
}

function getSuppressions(limit) {
  return listSuppressions.all(limit).map(function(row) {
    return {
      email: row.email,
      type: row.type,
      reason: row.reason,
      created_at: row.created_at
    };
  });
}

function buildRuntimeConfig(basePath) {
  return {
    basePath: basePath || config.adminBasePath,
    siteDomain: config.mailgunDomain || ''
  };
}

function readDashboardAsset(assetPath) {
  return fs.readFileSync(assetPath, 'utf8');
}

function renderDashboard(basePath) {
  var runtimeJson = JSON.stringify(buildRuntimeConfig(basePath));
  var template = readDashboardAsset(dashboardIndexPath);
  return template.split('__GMB_RUNTIME__').join(runtimeJson);
}

function maybeRedirectToTrailingSlash(req, res) {
  var originalUrl = req.originalUrl || '';
  var queryIndex = originalUrl.indexOf('?');
  var pathOnly = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl;

  if (pathOnly.endsWith('/')) return false;

  var suffix = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
  var basePath = req.baseUrl || config.adminBasePath;
  res.redirect(302, basePath + '/' + suffix);
  return true;
}

function createAdminRouter(getPollerState) {
  var router = express.Router();
  var readPollerState = typeof getPollerState === 'function' ? getPollerState : function() { return {}; };

  router.use(createAdminAuthMiddleware());

  router.get('/', function(req, res) {
    if (maybeRedirectToTrailingSlash(req, res)) return;

    try {
      res.type('html').send(renderDashboard(req.baseUrl || config.adminBasePath));
    } catch (err) {
      res.status(500).json({ message: 'Failed to render dashboard', error: err.message });
    }
  });

  router.get('/styles.css', function(_req, res) {
    try {
      res.type('css').send(readDashboardAsset(dashboardStylesPath));
    } catch (err) {
      res.status(500).json({ message: 'Failed to load styles', error: err.message });
    }
  });

  router.get('/app.js', function(_req, res) {
    try {
      res.type('application/javascript').send(readDashboardAsset(dashboardAppPath));
    } catch (err) {
      res.status(500).json({ message: 'Failed to load app script', error: err.message });
    }
  });

  router.get('/test-data.json', function(_req, res) {
    try {
      res.type('application/json').send(readDashboardAsset(dashboardTestDataPath));
    } catch (err) {
      res.status(500).json({ message: 'Failed to load dashboard test data', error: err.message });
    }
  });

  router.get('/api/health', function(req, res) {
    res.json({
      status: 'ok',
      service: 'ghost-mail-bridge',
      timestamp: new Date().toISOString(),
      path: req.baseUrl || config.adminBasePath,
      tables: getTableCounts(),
      poller: readPollerState()
    });
  });

  router.get('/api/summary', function(_req, res) {
    res.json(getSummary());
  });

  router.get('/api/failures', function(req, res) {
    var limit = parseLimit(req.query.limit, 25, 200);
    res.json({
      items: getRecentFailures(limit)
    });
  });

  router.get('/api/suppressions', function(req, res) {
    var limit = parseLimit(req.query.limit, 250, 1000);
    res.json({
      items: getSuppressions(limit)
    });
  });

  return router;
}

module.exports = {
  createAdminRouter: createAdminRouter
};
