var express = require('express');
var fs = require('fs');
var path = require('path');
var config = require('./config');
var { query, getTableCounts, listRuntimeHeartbeats } = require('./db');
var { getQueueDepth } = require('./sqs-client');
var { getSesAccountStatus } = require('./ses-account');

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
    '24h': true,
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
    '24h': { key: '24h', buckets: 24, stepHours: 1, label: 'Last 24 hours', axisLabel: 'Hour' },
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
  return base + '/ghost/api/admin/users/me/?fields=id';
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

function sumField(rows, key) {
  return rows.reduce(function(acc, row) {
    return acc + (Number(row[key]) || 0);
  }, 0);
}

function percentage(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

async function getBatchStatusCounts() {
  var rows = await query(
    'SELECT status, COUNT(*) AS c FROM batches GROUP BY status'
  );
  var counts = {
    queued: 0,
    processing: 0,
    partial: 0,
    failed: 0,
    completed: 0
  };

  rows.forEach(function(row) {
    if (counts[row.status] !== undefined) {
      counts[row.status] = Number(row.c) || 0;
    }
  });

  return counts;
}

async function getDeliveryData(periodKey) {
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

  var sentRows = await query(
    'SELECT FLOOR(UNIX_TIMESTAMP(created_at) / ?) * ? AS bucket, COUNT(*) AS c ' +
    'FROM recipient_emails WHERE created_at >= FROM_UNIXTIME(?) GROUP BY bucket',
    [stepSeconds, stepSeconds, startSeconds]
  );

  sentRows.forEach(function(row) {
    var bucket = Number(row.bucket) || 0;
    if (timelineByBucket[bucket]) {
      timelineByBucket[bucket].sent = Number(row.c) || 0;
    }
  });

  var eventRows = await query(
    'SELECT FLOOR(timestamp / ?) * ? AS bucket, event_type, COUNT(*) AS c ' +
    'FROM events WHERE timestamp >= ? AND event_type IN (?, ?, ?) ' +
    'AND COALESCE(NULLIF(message_id, \'\'), NULLIF(email_id, \'\')) IS NOT NULL ' +
    'GROUP BY bucket, event_type',
    [stepSeconds, stepSeconds, startSeconds, 'delivered', 'failed', 'complained']
  );

  eventRows.forEach(function(row) {
    var bucket = Number(row.bucket) || 0;
    var point = timelineByBucket[bucket];
    if (!point) return;
    var count = Number(row.c) || 0;
    if (row.event_type === 'delivered') point.delivered = count;
    if (row.event_type === 'failed') point.failed = count;
    if (row.event_type === 'complained') point.complained = count;
  });

  var uniqueOpens = await query(
    'SELECT bucket, COUNT(*) AS c FROM (' +
      'SELECT FLOOR(timestamp / ?) * ? AS bucket, LOWER(recipient) AS recipient_norm,' +
      'COALESCE(NULLIF(message_id, \'\'), NULLIF(email_id, \'\'), \'\') AS event_key ' +
      'FROM events WHERE timestamp >= ? AND event_type = ? ' +
      'AND COALESCE(NULLIF(message_id, \'\'), NULLIF(email_id, \'\')) IS NOT NULL ' +
      'GROUP BY bucket, recipient_norm, event_key' +
    ') AS grouped_events GROUP BY bucket',
    [stepSeconds, stepSeconds, startSeconds, 'opened']
  );

  uniqueOpens.forEach(function(row) {
    var bucket = Number(row.bucket) || 0;
    if (timelineByBucket[bucket]) {
      timelineByBucket[bucket].opened = Number(row.c) || 0;
    }
  });

  var uniqueClicks = await query(
    'SELECT bucket, COUNT(*) AS c FROM (' +
      'SELECT FLOOR(timestamp / ?) * ? AS bucket, LOWER(recipient) AS recipient_norm,' +
      'COALESCE(NULLIF(message_id, \'\'), NULLIF(email_id, \'\'), \'\') AS event_key ' +
      'FROM events WHERE timestamp >= ? AND event_type = ? ' +
      'AND COALESCE(NULLIF(message_id, \'\'), NULLIF(email_id, \'\')) IS NOT NULL ' +
      'GROUP BY bucket, recipient_norm, event_key' +
    ') AS grouped_events GROUP BY bucket',
    [stepSeconds, stepSeconds, startSeconds, 'clicked']
  );

  uniqueClicks.forEach(function(row) {
    var bucket = Number(row.bucket) || 0;
    if (timelineByBucket[bucket]) {
      timelineByBucket[bucket].clicked = Number(row.c) || 0;
    }
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

async function getSummary(periodKey) {
  var delivery = await getDeliveryData(periodKey);
  var since = getPeriodWindow(periodKey).startSeconds;
  var suppressionRows = await query(
    'SELECT type, COUNT(*) AS c FROM suppressions WHERE created_at >= FROM_UNIXTIME(?) GROUP BY type',
    [since]
  );
  var suppressionCounts = {
    bounces: 0,
    complaints: 0,
    unsubscribes: 0
  };

  suppressionRows.forEach(function(row) {
    if (suppressionCounts[row.type] !== undefined) {
      suppressionCounts[row.type] = Number(row.c) || 0;
    }
  });

  return {
    sent_24h: delivery.sent,
    delivered_24h: delivery.delivered,
    opened_24h: delivery.opened,
    clicked_24h: delivery.clicked,
    failed_24h: delivery.failed,
    complained_24h: delivery.complained,
    suppressions: suppressionCounts,
    jobs: await getBatchStatusCounts()
  };
}

async function getRecentFailures(limit, periodKey) {
  var params = ['failed', 'complained'];
  var sql =
    'SELECT id, event_type, severity, recipient, timestamp, message_id, email_id, ' +
    'delivery_status_code, delivery_status_message, delivery_status_enhanced ' +
    'FROM events WHERE event_type IN (?, ?)';

  if (periodKey) {
    sql += ' AND timestamp >= ?';
    params.push(getPeriodWindow(periodKey).startSeconds);
  }

  sql += ' ORDER BY timestamp DESC, id DESC LIMIT ?';
  params.push(limit);

  var rows = await query(sql, params);
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

async function getSuppressions(limit, periodKey) {
  var params = [];
  var sql = 'SELECT email, type, reason, created_at FROM suppressions';

  if (periodKey) {
    sql += ' WHERE created_at >= FROM_UNIXTIME(?)';
    params.push(getPeriodWindow(periodKey).startSeconds);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  var rows = await query(sql, params);
  return rows.map(function(row) {
    return {
      email: row.email,
      type: row.type,
      reason: row.reason,
      created_at: row.created_at
    };
  });
}

async function getWorkerRuntimeSnapshot(getRuntimeStatus) {
  var heartbeats = await listRuntimeHeartbeats('worker', config.runtimeHeartbeatStaleSeconds);
  var freshestWorker = heartbeats[0] || null;
  var localStatus = typeof getRuntimeStatus === 'function' ? getRuntimeStatus() : {};

  return {
    workers: heartbeats,
    worker: freshestWorker ? (freshestWorker.state.newsletterWorker || {}) : (localStatus.newsletterWorker || {}),
    poller: freshestWorker ? (freshestWorker.state.sesEventPoller || {}) : (localStatus.sesEventPoller || {})
  };
}

async function getQueueSnapshot() {
  var sendQueue = { visible: 0, inFlight: 0, delayed: 0 };
  var eventsQueue = { visible: 0, inFlight: 0, delayed: 0 };
  var sendQueueError = '';
  var eventsQueueError = '';

  try {
    sendQueue = await getQueueDepth(config.newsletterSendQueueUrl);
  } catch (err) {
    sendQueueError = err && err.message ? err.message : String(err);
  }

  try {
    eventsQueue = await getQueueDepth(config.sesEventsQueueUrl);
  } catch (err) {
    eventsQueueError = err && err.message ? err.message : String(err);
  }

  return {
    newsletterSend: sendQueue,
    sesEvents: eventsQueue,
    errors: {
      newsletterSend: sendQueueError,
      sesEvents: eventsQueueError
    }
  };
}

function buildRuntimeConfig(basePath) {
  return {
    basePath: basePath || config.adminBasePath,
    siteDomain: config.mailgunDomain || '',
    bridgeServiceName: 'ghost-mail-bridge',
    expectedBulkEmailBaseUrl: 'http://ghost-mail-bridge:3003/v3',
    awsRegion: config.awsRegion
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

function withAsync(handler) {
  return function(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function buildServiceStatus(health) {
  var workerOnline = health.worker && health.worker.isRunning;
  var pollerOnline = health.poller && health.poller.isRunning;
  var queueErrors = health.queues && health.queues.errors
    ? Object.keys(health.queues.errors).filter(function(key) { return !!health.queues.errors[key]; })
    : [];

  if (queueErrors.length > 0) return 'warn';
  if (!workerOnline || !pollerOnline) return 'warn';
  return 'ok';
}

function createAdminRouter(getRuntimeStatus) {
  var router = express.Router();

  router.use(createAdminAuthMiddleware());
  router.use(function(req, res, next) {
    if (req.path.indexOf('/fonts/') !== 0) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

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

  router.get('/api/health', withAsync(async function(req, res) {
    var runtime = await getWorkerRuntimeSnapshot(getRuntimeStatus);
    var queues = await getQueueSnapshot();
    var tables = await getTableCounts();
    var jobs = await getBatchStatusCounts();
    var sesAccount = await getSesAccountStatus();
    var health = {
      status: 'ok',
      service: 'ghost-mail-bridge',
      timestamp: new Date().toISOString(),
      path: req.baseUrl || config.adminBasePath,
      tables: tables,
      jobs: jobs,
      queues: queues,
      sesAccount: sesAccount,
      worker: runtime.worker,
      workers: runtime.workers,
      poller: runtime.poller
    };

    health.status = buildServiceStatus(health);
    health.queueDepth = queues.sesEvents.visible + queues.sesEvents.inFlight + queues.sesEvents.delayed;
    health.sendQueueDepth = queues.newsletterSend.visible + queues.newsletterSend.inFlight + queues.newsletterSend.delayed;

    res.json(health);
  }));

  router.get('/api/summary', withAsync(async function(req, res) {
    var periodKey = normalizePeriodKey(req.query.period);
    res.json(await getSummary(periodKey));
  }));

  router.get('/api/delivery', withAsync(async function(req, res) {
    var periodKey = normalizePeriodKey(req.query.period);
    res.json(await getDeliveryData(periodKey));
  }));

  router.get('/api/failures', withAsync(async function(req, res) {
    var limit = parseLimit(req.query.limit, 25, 200);
    var periodKey = normalizePeriodKey(req.query.period);
    res.json({
      items: await getRecentFailures(limit, periodKey)
    });
  }));

  router.get('/api/suppressions', withAsync(async function(req, res) {
    var limit = parseLimit(req.query.limit, 250, 1000);
    var periodKey = normalizePeriodKey(req.query.period);
    res.json({
      items: await getSuppressions(limit, periodKey)
    });
  }));

  router.use(function(err, _req, res, _next) {
    console.error('Admin dashboard error:', err && err.message ? err.message : String(err));
    res.status(500).json({
      message: 'Internal server error',
      error: err && err.message ? err.message : String(err)
    });
  });

  return router;
}

module.exports = {
  createAdminRouter: createAdminRouter
};
