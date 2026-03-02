var crypto = require('crypto');
var express = require('express');
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

function parseLimit(value, fallback, max) {
  var parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function safeEquals(a, b) {
  var left = Buffer.from(String(a || ''));
  var right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function buildGhostAdminSiteUrl() {
  var base = config.ghostAdminUrl.replace(/\/+$/, '');
  return base + '/ghost/api/admin/site/';
}

async function verifyGhostSession(req) {
  if (!config.ghostAdminUrl) return false;
  var cookie = req.headers.cookie;
  if (!cookie) return false;

  var controller = new AbortController();
  var timeout = setTimeout(function() {
    controller.abort();
  }, 5000);

  try {
    var response = await fetch(buildGhostAdminSiteUrl(), {
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

function unauthorized(res, message) {
  res.status(401).json({ message: message || 'Unauthorized' });
}

function createAdminAuthMiddleware() {
  return function(req, res, next) {
    if (config.adminApiKey) {
      var providedApiKey = req.headers['x-admin-api-key'] || req.query.apiKey || '';
      if (safeEquals(providedApiKey, config.adminApiKey)) {
        return next();
      }
      return unauthorized(res, 'Unauthorized: invalid admin API key');
    }

    if (config.ghostAdminUrl) {
      verifyGhostSession(req).then(function(ok) {
        if (ok) return next();
        return unauthorized(res, 'Unauthorized: Ghost admin session required');
      }).catch(function() {
        return unauthorized(res, 'Unauthorized: session verification failed');
      });
      return;
    }

    return next();
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

function renderDashboard(basePath) {
  var normalized = basePath || config.adminBasePath;
  var basePathJson = JSON.stringify(normalized);

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <title>Ghost Mail Bridge</title>',
    '  <style>',
    '    :root { color-scheme: light; --bg: #f4f7f8; --ink: #1a2a2f; --muted: #5d737c; --card: #ffffff; --line: #d8e2e6; --accent: #16434d; }',
    '    * { box-sizing: border-box; }',
    '    body { margin: 0; background: var(--bg); color: var(--ink); font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }',
    '    .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 18px 40px; }',
    '    h1 { margin: 0 0 6px; font-size: 28px; }',
    '    .sub { margin: 0 0 22px; color: var(--muted); }',
    '    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin-bottom: 18px; }',
    '    .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }',
    '    .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }',
    '    .value { font-size: 24px; margin-top: 6px; font-weight: 700; }',
    '    .panel { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 14px; }',
    '    .row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-bottom: 8px; }',
    '    table { width: 100%; border-collapse: collapse; font-size: 14px; }',
    '    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); }',
    '    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }',
    '    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div class="wrap">',
    '    <h1>Ghost Mail Bridge</h1>',
    '    <p class="sub">Operational view for newsletter delivery and event tracking.</p>',
    '    <div class="grid" id="summary-cards"></div>',
    '    <div class="panel">',
    '      <div class="row"><strong>System Health</strong><span id="health-meta" class="mono"></span></div>',
    '      <pre id="health-json" class="mono" style="margin:0; white-space:pre-wrap;"></pre>',
    '    </div>',
    '    <div class="panel">',
    '      <div class="row"><strong>Recent Failures / Complaints</strong><span id="failure-meta"></span></div>',
    '      <table>',
    '        <thead><tr><th>Time</th><th>Event</th><th>Recipient</th><th>Reason</th></tr></thead>',
    '        <tbody id="failure-rows"></tbody>',
    '      </table>',
    '    </div>',
    '  </div>',
    '  <script>',
    '    (function(){',
    '      var basePath = ' + basePathJson + ';',
    '      var cardsEl = document.getElementById("summary-cards");',
    '      var healthEl = document.getElementById("health-json");',
    '      var healthMetaEl = document.getElementById("health-meta");',
    '      var failureEl = document.getElementById("failure-rows");',
    '      var failureMetaEl = document.getElementById("failure-meta");',
    '',
    '      function card(label, value) {',
    '        return "<div class=\\"card\\"><div class=\\"label\\">" + label + "</div><div class=\\"value\\">" + value + "</div></div>";',
    '      }',
    '',
    '      function fmtTime(ts) {',
    '        if (!ts) return "-";',
    '        return new Date(ts * 1000).toLocaleString();',
    '      }',
    '',
    '      function esc(str) {',
    '        return String(str === undefined || str === null ? "" : str)',
    '          .replace(/&/g, "&amp;")',
    '          .replace(/</g, "&lt;")',
    '          .replace(/>/g, "&gt;");',
    '      }',
    '',
    '      async function load() {',
    '        try {',
    '          var [summaryResp, healthResp, failuresResp] = await Promise.all([',
    '            fetch(basePath + "/api/summary"),',
    '            fetch(basePath + "/api/health"),',
    '            fetch(basePath + "/api/failures?limit=25")',
    '          ]);',
    '',
    '          if (!summaryResp.ok || !healthResp.ok || !failuresResp.ok) {',
    '            throw new Error("Dashboard API request failed");',
    '          }',
    '',
    '          var summary = await summaryResp.json();',
    '          var health = await healthResp.json();',
    '          var failures = await failuresResp.json();',
    '',
    '          cardsEl.innerHTML = [',
    '            card("Sent (24h)", summary.sent_24h),',
    '            card("Delivered (24h)", summary.delivered_24h),',
    '            card("Opened (24h)", summary.opened_24h),',
    '            card("Clicked (24h)", summary.clicked_24h),',
    '            card("Failed (24h)", summary.failed_24h),',
    '            card("Complained (24h)", summary.complained_24h),',
    '            card("Suppressed Bounces", summary.suppressions.bounces),',
    '            card("Suppressed Complaints", summary.suppressions.complaints)',
    '          ].join("");',
    '',
    '          healthMetaEl.textContent = "updated " + new Date().toLocaleTimeString();',
    '          healthEl.textContent = JSON.stringify(health, null, 2);',
    '',
    '          failureMetaEl.textContent = failures.items.length + " rows";',
    '          failureEl.innerHTML = failures.items.map(function(row) {',
    '            return "<tr>" +',
    '              "<td>" + esc(fmtTime(row.timestamp)) + "</td>" +',
    '              "<td>" + esc(row.event) + "</td>" +',
    '              "<td class=\\"mono\\">" + esc(row.recipient) + "</td>" +',
    '              "<td>" + esc(row.reason || row.enhanced_code || "-") + "</td>" +',
    '              "</tr>";',
    '          }).join("") || "<tr><td colspan=\\"4\\">No recent failed/complained events.</td></tr>";',
    '        } catch (err) {',
    '          cardsEl.innerHTML = card("Error", "Failed to load");',
    '          healthEl.textContent = String(err && err.message ? err.message : err);',
    '          failureEl.innerHTML = "<tr><td colspan=\\"4\\">Failed to load</td></tr>";',
    '        }',
    '      }',
    '',
    '      load();',
    '      setInterval(load, 15000);',
    '    })();',
    '  </script>',
    '</body>',
    '</html>'
  ].join('\n');
}

function createAdminRouter(getPollerState) {
  var router = express.Router();
  var readPollerState = typeof getPollerState === 'function' ? getPollerState : function() { return {}; };

  router.use(createAdminAuthMiddleware());

  router.get('/', function(req, res) {
    res.type('html').send(renderDashboard(req.baseUrl || config.adminBasePath));
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

  router.get('/api/summary', function(req, res) {
    res.json(getSummary());
  });

  router.get('/api/failures', function(req, res) {
    var limit = parseLimit(req.query.limit, 25, 200);
    res.json({
      items: getRecentFailures(limit)
    });
  });

  return router;
}

module.exports = {
  createAdminRouter: createAdminRouter
};
