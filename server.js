var express = require('express');
var config = require('./lib/config');
var authMiddleware = require('./lib/auth');
var { db, cleanupInterval } = require('./lib/db');
var handleSendEmail = require('./lib/send-email');
var handleGetEvents = require('./lib/events-api');
var handleDeleteSuppression = require('./lib/suppression-api');
var { createAdminRouter } = require('./lib/admin-dashboard');
var { startPolling, getPollerState } = require('./lib/sqs-poller');

var app = express();

// --- Health check (unauthenticated) ---
app.get('/health', function(req, res) {
  var messageMapCount = db.prepare('SELECT COUNT(*) as c FROM message_map').get().c;
  var recipientCount = db.prepare('SELECT COUNT(*) as c FROM recipient_emails').get().c;
  var eventCount = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  var suppressionCount = db.prepare('SELECT COUNT(*) as c FROM suppressions').get().c;

  res.json({
    status: 'ok',
    tables: {
      message_map: messageMapCount,
      recipient_emails: recipientCount,
      events: eventCount,
      suppressions: suppressionCount
    }
  });
});

// --- Admin dashboard and API ---
app.use(config.adminBasePath, createAdminRouter(getPollerState));

// --- Auth middleware for /v3 prefix ---
app.use('/v3', authMiddleware);

// --- Email sending ---
app.post('/v3/:domain/messages', handleSendEmail);

// --- Events endpoint ---
app.get('/v3/:domain/events', handleGetEvents);
app.get('/v3/:domain/events/:pageToken', handleGetEvents);

// --- Suppression deletion ---
app.delete('/v3/:domain/:type/:email', handleDeleteSuppression);

// --- Start ---
var stopPolling;
var server = app.listen(config.port, function() {
  console.log('ghost-mail-bridge listening on port ' + config.port);
  console.log('  Domain: ' + config.mailgunDomain);
  console.log('  Region: ' + config.awsRegion);
  console.log('  Configuration set: ' + config.sesConfigurationSet);
  console.log('  Send concurrency: ' + config.sendConcurrency);
  console.log('  Admin dashboard path: ' + config.adminBasePath);
  if (config.adminApiKey) {
    console.log('  Admin auth: ADMIN_API_KEY');
  } else if (config.ghostAdminUrl) {
    console.log('  Admin auth: Ghost session via ' + config.ghostAdminUrl);
  } else {
    console.log('  Admin auth: none (set ADMIN_API_KEY or GHOST_ADMIN_URL to protect admin routes)');
  }
  stopPolling = startPolling();
});

// --- Graceful shutdown ---
var shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('Shutting down...');
  if (stopPolling) stopPolling();
  clearInterval(cleanupInterval);

  server.close(function() {
    db.close();
    console.log('Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
