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

function getProto(req) {
  var forwardedProto = req.headers['x-forwarded-proto'];
  if (Array.isArray(forwardedProto) && forwardedProto.length > 0) {
    return String(forwardedProto[0]).split(',')[0].trim();
  }
  if (typeof forwardedProto === 'string' && forwardedProto.trim()) {
    return forwardedProto.split(',')[0].trim();
  }
  if (req.protocol) return req.protocol;
  return 'https';
}

function buildGhostBaseUrl(req) {
  if (config.ghostAdminUrl) {
    return config.ghostAdminUrl.replace(/\/+$/, '');
  }

  var host = req.headers.host;
  if (!host) return null;
  return getProto(req) + '://' + host;
}

function buildGhostAdminSiteUrl(req) {
  var base = buildGhostBaseUrl(req);
  if (!base) return null;
  return base + '/ghost/api/admin/site/';
}

function buildSigninUrl(req) {
  var base = buildGhostBaseUrl(req);
  if (!base) return '/ghost/#/signin';
  return base + '/ghost/#/signin';
}

function isBrowserHtmlRequest(req) {
  var accept = req.headers.accept || '';
  return accept.indexOf('text/html') !== -1;
}

async function verifyGhostSession(req) {
  var siteUrl = buildGhostAdminSiteUrl(req);
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
    return res.redirect(302, buildSigninUrl(req));
  }

  return res.status(401).json({ message: message || 'Unauthorized' });
}

function createAdminAuthMiddleware() {
  return function(req, res, next) {
    if (config.adminApiKey) {
      var providedApiKey = req.headers['x-admin-api-key'] || req.query.apiKey || '';
      if (safeEquals(providedApiKey, config.adminApiKey)) {
        return next();
      }
      return unauthorized(req, res, 'Unauthorized: invalid admin API key');
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

function renderDashboard(basePath) {
  var normalized = basePath || config.adminBasePath;
  var basePathJson = JSON.stringify(normalized);
  var basePathAttr = String(normalized).replace(/"/g, '&quot;');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ghost Mail Bridge</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f8;
      --panel: #ffffff;
      --rail: #f3f4f5;
      --line: #dde3e8;
      --ink: #15212a;
      --muted: #6b7a85;
      --accent: #111315;
      --active: #ffffff;
      --active-line: #cfd6dd;
      --ok: #168753;
      --warn: #a65c00;
      --danger: #bb2b2b;
      --radius: 10px;
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      min-height: 100%;
      background: var(--bg);
      color: var(--ink);
      font-family: "Inter", "Inter var", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    }

    a {
      color: inherit;
      text-decoration: none;
    }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 288px 1fr;
    }

    .rail {
      background: var(--rail);
      border-right: 1px solid var(--line);
      padding: 28px 20px 20px;
      display: flex;
      flex-direction: column;
      gap: 22px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 700;
      font-size: 29px;
      letter-spacing: -0.02em;
    }

    .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #111315;
      flex: 0 0 auto;
    }

    .search {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 10px;
      height: 44px;
      padding: 0 14px;
      font-size: 14px;
      color: #7c8a95;
      display: flex;
      align-items: center;
    }

    .nav-group {
      display: grid;
      gap: 6px;
    }

    .nav-title {
      font-size: 11px;
      letter-spacing: 0.08em;
      color: var(--muted);
      text-transform: uppercase;
      margin: 8px 10px 4px;
    }

    .nav-item {
      min-height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      padding: 0 12px;
      font-size: 16px;
      color: #26343d;
      border: 1px solid transparent;
    }

    .nav-item:hover {
      background: #edf0f2;
    }

    .nav-item.active {
      background: var(--active);
      border-color: var(--active-line);
      font-weight: 600;
      color: #111315;
    }

    .nav-spacer {
      flex: 1 1 auto;
    }

    .identity {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 10px;
      padding: 12px;
      font-size: 14px;
      color: var(--muted);
    }

    .identity strong {
      display: block;
      color: #18252f;
      font-size: 15px;
      margin-bottom: 2px;
    }

    .main {
      padding: 26px 30px 40px;
    }

    .main-inner {
      max-width: 1180px;
    }

    .head {
      margin-bottom: 18px;
    }

    .head h1 {
      margin: 0;
      font-size: 40px;
      letter-spacing: -0.03em;
      line-height: 1.05;
      font-weight: 740;
    }

    .head p {
      margin: 9px 0 0;
      color: var(--muted);
      font-size: 16px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }

    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 12px;
      min-height: 92px;
      display: grid;
      align-content: space-between;
    }

    .metric-label {
      font-size: 11px;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 590;
    }

    .metric-value {
      margin-top: 10px;
      font-size: 34px;
      letter-spacing: -0.02em;
      font-weight: 700;
      color: #111315;
      line-height: 1;
    }

    .metric-value.ok {
      color: var(--ok);
    }

    .metric-value.warn {
      color: var(--warn);
    }

    .metric-value.danger {
      color: var(--danger);
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 14px;
      margin-bottom: 14px;
    }

    .panel-head {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      font-size: 22px;
      letter-spacing: -0.01em;
      font-weight: 650;
    }

    .panel-meta {
      color: var(--muted);
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0;
    }

    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }

    pre.health-json {
      margin: 0;
      white-space: pre-wrap;
      background: #f8fafb;
      border: 1px solid #e5eaee;
      border-radius: 8px;
      padding: 12px;
      font-size: 13px;
      line-height: 1.45;
      color: #31424e;
      max-height: 320px;
      overflow: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    th, td {
      padding: 9px 8px;
      text-align: left;
      border-bottom: 1px solid #e7ecf0;
      vertical-align: top;
    }

    th {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      font-weight: 650;
    }

    tbody tr:hover {
      background: #fafbfc;
    }

    .event-pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 9px;
      background: #edf1f4;
      color: #374955;
      text-transform: capitalize;
    }

    .event-pill.failed {
      background: #fbeceb;
      color: #b52d2d;
    }

    .event-pill.complained {
      background: #fff2e4;
      color: #9a5c16;
    }

    @media (max-width: 1024px) {
      .shell {
        grid-template-columns: 1fr;
      }

      .rail {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }

      .main {
        padding-top: 18px;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="rail">
      <div class="brand">
        <span class="brand-dot"></span>
        <span>Ghost</span>
      </div>
      <div class="search">Search admin</div>

      <nav class="nav-group">
        <a class="nav-item" href="/ghost/#/analytics">Analytics</a>
        <a class="nav-item" href="/" target="_blank" rel="noreferrer">View site</a>
      </nav>

      <div class="nav-group">
        <div class="nav-title">Publishing</div>
        <a class="nav-item" href="/ghost/#/posts">Posts</a>
        <a class="nav-item" href="/ghost/#/members">Members</a>
        <a class="nav-item" href="/ghost/#/settings">Settings</a>
      </div>

      <div class="nav-group">
        <div class="nav-title">Bridge</div>
        <a class="nav-item active" href="${basePathAttr}">Email delivery</a>
      </div>

      <div class="nav-spacer"></div>

      <div class="identity">
        <strong>Ghost Mail Bridge</strong>
        Operational panel
      </div>
    </aside>

    <main class="main">
      <div class="main-inner">
        <header class="head">
          <h1>Email</h1>
          <p>Live operational status for newsletter delivery and event processing.</p>
        </header>

        <section class="metrics" id="summary-cards"></section>

        <section class="panel">
          <div class="panel-head">
            <span>System health</span>
            <span id="health-meta" class="panel-meta mono"></span>
          </div>
          <pre id="health-json" class="health-json mono"></pre>
        </section>

        <section class="panel">
          <div class="panel-head">
            <span>Recent failures and complaints</span>
            <span id="failure-meta" class="panel-meta"></span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Recipient</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody id="failure-rows"></tbody>
          </table>
        </section>
      </div>
    </main>
  </div>

  <script>
    (function () {
      var basePath = ${basePathJson};
      var cardsEl = document.getElementById("summary-cards");
      var healthEl = document.getElementById("health-json");
      var healthMetaEl = document.getElementById("health-meta");
      var failureEl = document.getElementById("failure-rows");
      var failureMetaEl = document.getElementById("failure-meta");

      function metricClass(label, value) {
        if (label.indexOf("Failed") === 0 || label.indexOf("Complained") === 0) {
          return value > 0 ? "danger" : "ok";
        }
        if (label.indexOf("Suppressed") === 0) {
          return value > 0 ? "warn" : "ok";
        }
        return "";
      }

      function metric(label, value) {
        var cls = metricClass(label, value);
        return "<article class=\\"metric\\">" +
          "<div class=\\"metric-label\\">" + label + "</div>" +
          "<div class=\\"metric-value " + cls + "\\">" + value + "</div>" +
          "</article>";
      }

      function fmtTime(ts) {
        if (!ts) return "-";
        return new Date(ts * 1000).toLocaleString();
      }

      function esc(str) {
        return String(str === undefined || str === null ? "" : str)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      function eventPill(evt) {
        var eventName = esc(evt || "");
        return "<span class=\\"event-pill " + eventName + "\\">" + eventName + "</span>";
      }

      async function load() {
        try {
          var responses = await Promise.all([
            fetch(basePath + "/api/summary"),
            fetch(basePath + "/api/health"),
            fetch(basePath + "/api/failures?limit=25")
          ]);

          if (!responses[0].ok || !responses[1].ok || !responses[2].ok) {
            throw new Error("Dashboard API request failed");
          }

          var summary = await responses[0].json();
          var health = await responses[1].json();
          var failures = await responses[2].json();

          cardsEl.innerHTML = [
            metric("Sent (24h)", summary.sent_24h),
            metric("Delivered (24h)", summary.delivered_24h),
            metric("Opened (24h)", summary.opened_24h),
            metric("Clicked (24h)", summary.clicked_24h),
            metric("Failed (24h)", summary.failed_24h),
            metric("Complained (24h)", summary.complained_24h),
            metric("Suppressed bounces", summary.suppressions.bounces),
            metric("Suppressed complaints", summary.suppressions.complaints)
          ].join("");

          healthMetaEl.textContent = "Updated " + new Date().toLocaleTimeString();
          healthEl.textContent = JSON.stringify(health, null, 2);

          failureMetaEl.textContent = failures.items.length + " rows";
          failureEl.innerHTML = failures.items.map(function (row) {
            return "<tr>" +
              "<td>" + esc(fmtTime(row.timestamp)) + "</td>" +
              "<td>" + eventPill(row.event) + "</td>" +
              "<td class=\\"mono\\">" + esc(row.recipient) + "</td>" +
              "<td>" + esc(row.reason || row.enhanced_code || "-") + "</td>" +
              "</tr>";
          }).join("") || "<tr><td colspan=\\"4\\">No recent failed or complained events.</td></tr>";
        } catch (err) {
          cardsEl.innerHTML = metric("Error", "Failed");
          healthEl.textContent = String(err && err.message ? err.message : err);
          failureEl.innerHTML = "<tr><td colspan=\\"4\\">Failed to load</td></tr>";
          failureMetaEl.textContent = "";
        }
      }

      load();
      setInterval(load, 15000);
    })();
  </script>
</body>
</html>`;
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
