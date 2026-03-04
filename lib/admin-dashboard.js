var express = require('express');
var fs = require('fs');
var path = require('path');
var config = require('./config');
var { db } = require('./db');

var countMessageMap = db.prepare('SELECT COUNT(*) as c FROM message_map');
var countRecipientEmails = db.prepare('SELECT COUNT(*) as c FROM recipient_emails');
var countEvents = db.prepare('SELECT COUNT(*) as c FROM events');
var countSuppressions = db.prepare('SELECT COUNT(*) as c FROM suppressions');
var countSuppressionType = db.prepare('SELECT COUNT(*) as c FROM suppressions WHERE type = ?');
var countSuppressionTypeSince = db.prepare(
  "SELECT COUNT(*) as c FROM suppressions WHERE type = ? AND CAST(strftime('%s', created_at) AS INTEGER) >= ?"
);
var aggregateSentByBucket = db.prepare(
  "SELECT CAST((CAST(strftime('%s', created_at) AS INTEGER) / ?) AS INTEGER) * ? AS bucket, COUNT(*) as c " +
  "FROM recipient_emails WHERE CAST(strftime('%s', created_at) AS INTEGER) >= ? GROUP BY bucket"
);
var aggregateEventByBucket = db.prepare(
  'SELECT CAST((timestamp / ?) AS INTEGER) * ? AS bucket, event_type, COUNT(*) as c ' +
  'FROM events WHERE timestamp >= ? AND event_type IN (?, ?, ?) GROUP BY bucket, event_type'
);
var aggregateUniqueEventByBucket = db.prepare(
  'SELECT bucket, COUNT(*) as c FROM (' +
  ' SELECT CAST((timestamp / ?) AS INTEGER) * ? AS bucket,' +
  " lower(recipient) AS recipient_norm," +
  " COALESCE(NULLIF(message_id, ''), NULLIF(email_id, ''), '') AS event_key" +
  ' FROM events WHERE timestamp >= ? AND event_type = ?' +
  ' GROUP BY bucket, recipient_norm, event_key' +
  ') GROUP BY bucket'
);
var recentFailures = db.prepare(
  'SELECT id, event_type, severity, recipient, timestamp, message_id, email_id,' +
  ' delivery_status_code, delivery_status_message, delivery_status_enhanced' +
  ' FROM events WHERE event_type IN (?, ?) ORDER BY timestamp DESC, id DESC LIMIT ?'
);
var recentFailuresSince = db.prepare(
  'SELECT id, event_type, severity, recipient, timestamp, message_id, email_id,' +
  ' delivery_status_code, delivery_status_message, delivery_status_enhanced' +
  ' FROM events WHERE event_type IN (?, ?) AND timestamp >= ? ORDER BY timestamp DESC, id DESC LIMIT ?'
);
var listSuppressions = db.prepare(
  'SELECT email, type, reason, created_at FROM suppressions ORDER BY created_at DESC LIMIT ?'
);
var listSuppressionsSince = db.prepare(
  "SELECT email, type, reason, created_at FROM suppressions " +
  "WHERE CAST(strftime('%s', created_at) AS INTEGER) >= ? ORDER BY created_at DESC LIMIT ?"
);

var dashboardAssetsDir = path.join(__dirname, 'admin-dashboard-assets');
var dashboardIndexPath = path.join(dashboardAssetsDir, 'index.html');
var dashboardStylesPath = path.join(dashboardAssetsDir, 'styles.css');
var dashboardAppPath = path.join(dashboardAssetsDir, 'app.js');
var dashboardTestDataPath = path.join(dashboardAssetsDir, 'test-data.json');
var dashboardFontsDir = path.join(dashboardAssetsDir, 'fonts');

function parseLimit(value, fallback, max) {
  var parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function normalizePeriodKey(value) {
  var normalized = String(value || '').trim().toLowerCase();
  var allowed = {
    '7d': true,
    '30d': true,
    '90d': true,
    ytd: true,
    '12m': true,
    all: true
  };
  if (!allowed[normalized]) return '30d';
  return normalized;
}

function getPeriodConfig(periodKey) {
  var key = normalizePeriodKey(periodKey);
  var now = new Date();
  var yearStart = new Date(now.getFullYear(), 0, 1);
  var ytdDays = Math.max(1, Math.ceil((now.getTime() - yearStart.getTime()) / 86400000));
  var presets = {
    '7d': { key: '7d', buckets: 7, stepHours: 24, label: 'Last 7 days', axisLabel: 'Date' },
    '30d': { key: '30d', buckets: 30, stepHours: 24, label: 'Last 30 days', axisLabel: 'Date' },
    '90d': { key: '90d', buckets: 90, stepHours: 24, label: 'Last 90 days', axisLabel: 'Date' },
    ytd: { key: 'ytd', buckets: ytdDays, stepHours: 24, label: 'Year to date', axisLabel: 'Date' },
    '12m': { key: '12m', buckets: 12, stepHours: 24 * 30, label: 'Last 12 months', axisLabel: 'Month' },
    all: { key: 'all', buckets: 24, stepHours: 24 * 30, label: 'All time', axisLabel: 'Month' }
  };

  return presets[key] || presets['30d'];
}

function getPeriodWindow(periodKey) {
  var period = getPeriodConfig(periodKey);
  var stepSeconds = period.stepHours * 3600;
  var nowSeconds = Math.floor(Date.now() / 1000);
  var endBucketStart = Math.floor(nowSeconds / stepSeconds) * stepSeconds;
  var startBucketStart = endBucketStart - (period.buckets - 1) * stepSeconds;

  return {
    period: period,
    stepSeconds: stepSeconds,
    startSeconds: startBucketStart,
    endSeconds: endBucketStart
  };
}

function buildGhostBaseUrl() {
  if (!config.ghostAdminUrl) return null;
  return config.ghostAdminUrl.replace(/\/+$/, '');
}

function buildGhostSessionVerifyUrl() {
  var base = buildGhostBaseUrl();
  if (!base) return null;
  return base + '/ghost/api/admin/users/me/';
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
  var verifyUrl = buildGhostSessionVerifyUrl();
  if (!verifyUrl) return false;

  var cookie = req.headers.cookie;
  if (!cookie) return false;

  var controller = new AbortController();
  var timeout = setTimeout(function() {
    controller.abort();
  }, 5000);

  try {
    var response = await fetch(verifyUrl, {
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
    if (config.disableAdminAuth) {
      return next();
    }

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

function sumField(rows, key) {
  return rows.reduce(function(acc, row) {
    return acc + (Number(row[key]) || 0);
  }, 0);
}

function percentage(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function getDeliveryData(periodKey) {
  var window = getPeriodWindow(periodKey);
  var period = window.period;
  var stepSeconds = window.stepSeconds;
  var startSeconds = window.startSeconds;

  var timeline = [];
  var timelineByBucket = Object.create(null);
  for (var i = 0; i < period.buckets; i += 1) {
    var bucket = startSeconds + i * stepSeconds;
    var point = {
      hour: new Date(bucket * 1000).toISOString(),
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      failed: 0,
      complained: 0
    };
    timeline.push(point);
    timelineByBucket[bucket] = point;
  }

  aggregateSentByBucket.all(stepSeconds, stepSeconds, startSeconds).forEach(function(row) {
    var bucket = Number(row.bucket) || 0;
    if (!timelineByBucket[bucket]) return;
    timelineByBucket[bucket].sent = Number(row.c) || 0;
  });

  aggregateEventByBucket
    .all(stepSeconds, stepSeconds, startSeconds, 'delivered', 'failed', 'complained')
    .forEach(function(row) {
      var bucket = Number(row.bucket) || 0;
      if (!timelineByBucket[bucket]) return;
      var count = Number(row.c) || 0;
      if (row.event_type === 'delivered') timelineByBucket[bucket].delivered = count;
      if (row.event_type === 'failed') timelineByBucket[bucket].failed = count;
      if (row.event_type === 'complained') timelineByBucket[bucket].complained = count;
    });

  aggregateUniqueEventByBucket.all(stepSeconds, stepSeconds, startSeconds, 'opened').forEach(function(row) {
    var bucket = Number(row.bucket) || 0;
    if (!timelineByBucket[bucket]) return;
    timelineByBucket[bucket].opened = Number(row.c) || 0;
  });

  aggregateUniqueEventByBucket.all(stepSeconds, stepSeconds, startSeconds, 'clicked').forEach(function(row) {
    var bucket = Number(row.bucket) || 0;
    if (!timelineByBucket[bucket]) return;
    timelineByBucket[bucket].clicked = Number(row.c) || 0;
  });

  var totals = {
    sent: sumField(timeline, 'sent'),
    delivered: sumField(timeline, 'delivered'),
    opened: sumField(timeline, 'opened'),
    clicked: sumField(timeline, 'clicked'),
    failed: sumField(timeline, 'failed'),
    complained: sumField(timeline, 'complained')
  };

  return {
    sent: totals.sent,
    delivered: totals.delivered,
    opened: totals.opened,
    clicked: totals.clicked,
    failed: totals.failed,
    complained: totals.complained,
    period: period,
    timeline: timeline,
    rates: {
      delivery: percentage(totals.delivered, totals.sent),
      open: percentage(totals.opened, totals.delivered),
      click: percentage(totals.clicked, totals.delivered),
      failure: percentage(totals.failed, totals.sent),
      complaint: percentage(totals.complained, totals.delivered)
    }
  };
}

function getSummary(periodKey) {
  var delivery = getDeliveryData(periodKey);
  var since = getPeriodWindow(periodKey).startSeconds;

  return {
    sent_24h: delivery.sent,
    delivered_24h: delivery.delivered,
    opened_24h: delivery.opened,
    clicked_24h: delivery.clicked,
    failed_24h: delivery.failed,
    complained_24h: delivery.complained,
    suppressions: {
      bounces: periodKey ? countSuppressionTypeSince.get('bounces', since).c : countSuppressionType.get('bounces').c,
      complaints: periodKey ? countSuppressionTypeSince.get('complaints', since).c : countSuppressionType.get('complaints').c,
      unsubscribes: periodKey ? countSuppressionTypeSince.get('unsubscribes', since).c : countSuppressionType.get('unsubscribes').c
    }
  };
}

function getRecentFailures(limit, periodKey) {
  var rows;
  if (periodKey) {
    var since = getPeriodWindow(periodKey).startSeconds;
    rows = recentFailuresSince.all('failed', 'complained', since, limit);
  } else {
    rows = recentFailures.all('failed', 'complained', limit);
  }

  return rows.map(function(row) {
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

function getSuppressions(limit, periodKey) {
  var rows;
  if (periodKey) {
    var since = getPeriodWindow(periodKey).startSeconds;
    rows = listSuppressionsSince.all(since, limit);
  } else {
    rows = listSuppressions.all(limit);
  }

  return rows.map(function(row) {
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
  return template.split('__GMB_RUNTIME_JSON__').join(runtimeJson);
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

  router.use('/fonts', express.static(dashboardFontsDir, {
    fallthrough: false,
    immutable: true,
    maxAge: '365d'
  }));

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
    var periodKey = normalizePeriodKey(_req.query.period);
    res.json(getSummary(periodKey));
  });

  router.get('/api/delivery', function(req, res) {
    var periodKey = normalizePeriodKey(req.query.period);
    res.json(getDeliveryData(periodKey));
  });

  router.get('/api/failures', function(req, res) {
    var limit = parseLimit(req.query.limit, 25, 200);
    var periodKey = normalizePeriodKey(req.query.period);
    res.json({
      items: getRecentFailures(limit, periodKey)
    });
  });

  router.get('/api/suppressions', function(req, res) {
    var limit = parseLimit(req.query.limit, 250, 1000);
    var periodKey = normalizePeriodKey(req.query.period);
    res.json({
      items: getSuppressions(limit, periodKey)
    });
  });

  return router;
}

module.exports = {
  createAdminRouter: createAdminRouter
};
