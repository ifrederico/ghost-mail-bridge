var crypto = require('crypto');
var express = require('express');
var config = require('./lib/config');
var authMiddleware = require('./lib/auth');
var {
  initDb,
  closeDb,
  getTableCounts,
  updateRuntimeHeartbeat,
  startCleanupTask
} = require('./lib/db');
var handleSendEmail = require('./lib/send-email');
var handleGetEvents = require('./lib/events-api');
var handleDeleteSuppression = require('./lib/suppression-api');
var { createAdminRouter } = require('./lib/admin-dashboard');
var { startPolling, getPollerState } = require('./lib/sqs-poller');
var { startNewsletterWorker, getWorkerState } = require('./lib/newsletter-worker');
var { getSesAccountStatus } = require('./lib/ses-account');

var instanceId = crypto.randomUUID();

function withAsync(handler) {
  return function(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function isApiRole() {
  return config.runtimeRole === 'api' || config.runtimeRole === 'all';
}

function isWorkerRole() {
  return config.runtimeRole === 'worker' || config.runtimeRole === 'all';
}

function buildRuntimeStatus() {
  return {
    role: config.runtimeRole,
    newsletterWorker: getWorkerState(),
    sesEventPoller: getPollerState()
  };
}

function startHeartbeatLoop() {
  var timer = setInterval(function() {
    updateRuntimeHeartbeat(instanceId, isWorkerRole() ? 'worker' : 'api', buildRuntimeStatus()).catch(function(err) {
      console.error('Runtime heartbeat error:', err && err.message ? err.message : String(err));
    });
  }, config.heartbeatIntervalMs);

  updateRuntimeHeartbeat(instanceId, isWorkerRole() ? 'worker' : 'api', buildRuntimeStatus()).catch(function(err) {
    console.error('Runtime heartbeat bootstrap error:', err && err.message ? err.message : String(err));
  });

  return timer;
}

async function bootstrap() {
  await initDb();
  startCleanupTask();

  var app = express();
  var server = null;
  var stopEventPoller = null;
  var stopNewsletterWorker = null;
  var heartbeatTimer = startHeartbeatLoop();

  if (isApiRole()) {
    app.get('/health', withAsync(async function(_req, res) {
      res.json({
        status: 'ok',
        tables: await getTableCounts(),
        sesAccount: await getSesAccountStatus()
      });
    }));

    app.use(config.adminBasePath, createAdminRouter(buildRuntimeStatus));
    app.use('/v3', authMiddleware);
    app.post('/v3/:domain/messages', withAsync(handleSendEmail));
    app.get('/v3/:domain/events', withAsync(handleGetEvents));
    app.get('/v3/:domain/events/:pageToken', withAsync(handleGetEvents));
    app.delete('/v3/:domain/:type/:email', withAsync(handleDeleteSuppression));
    app.use(function(err, _req, res, _next) {
      console.error('API error:', err && err.message ? err.message : String(err));
      res.status(500).json({
        message: 'Internal server error',
        error: err && err.message ? err.message : String(err)
      });
    });

    server = app.listen(config.port, function() {
      console.log('ghost-mail-bridge API listening on port ' + config.port);
      console.log('  Role: ' + config.runtimeRole);
      console.log('  Domain: ' + config.mailgunDomain);
      console.log('  Region: ' + config.awsRegion);
      console.log('  Configuration set: ' + config.sesConfigurationSet);
      console.log('  Admin dashboard path: ' + config.adminBasePath);
      console.log('  Database: MySQL');
      console.log('  Send queue: ' + config.newsletterSendQueueUrl);
      console.log('  SES event queue: ' + config.sesEventsQueueUrl);
      if (config.disableAdminAuth) {
        console.log('  Admin auth: DISABLED (DISABLE_ADMIN_AUTH=1)');
      } else if (config.ghostAdminUrl) {
        console.log('  Admin auth: Ghost session via ' + config.ghostAdminUrl);
      } else {
        console.log('  Admin auth: DISABLED (set GHOST_ADMIN_URL)');
      }
    });
  }

  if (isWorkerRole()) {
    if (config.disableNewsletterWorker) {
      console.log('Newsletter worker: DISABLED (DISABLE_NEWSLETTER_WORKER=1)');
    } else {
      stopNewsletterWorker = startNewsletterWorker(instanceId);
    }

    if (config.disableSesEventPoller) {
      console.log('SES event poller: DISABLED (DISABLE_SES_EVENT_POLLER=1)');
    } else {
      stopEventPoller = startPolling();
    }

    console.log('ghost-mail-bridge worker runtime started');
    console.log('  Role: ' + config.runtimeRole);
    console.log('  Send batch size: ' + config.sendBatchSize);
    console.log('  Send batch concurrency: ' + config.sendBatchConcurrency);
    console.log('  Per-recipient concurrency: ' + config.sendConcurrency);
  }

  var shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('Shutting down...');
    clearInterval(heartbeatTimer);
    if (stopNewsletterWorker) stopNewsletterWorker();
    if (stopEventPoller) stopEventPoller();

    await updateRuntimeHeartbeat(instanceId, isWorkerRole() ? 'worker' : 'api', {
      role: config.runtimeRole,
      stopping: true,
      newsletterWorker: getWorkerState(),
      sesEventPoller: getPollerState()
    }).catch(function(_err) {});

    if (server) {
      await new Promise(function(resolve) {
        server.close(resolve);
      });
    }

    await closeDb();
    console.log('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', function() {
    shutdown().catch(function(err) {
      console.error('Shutdown error:', err && err.message ? err.message : String(err));
      process.exit(1);
    });
  });

  process.on('SIGINT', function() {
    shutdown().catch(function(err) {
      console.error('Shutdown error:', err && err.message ? err.message : String(err));
      process.exit(1);
    });
  });
}

bootstrap().catch(function(err) {
  console.error('Startup error:', err && err.message ? err.message : String(err));
  process.exit(1);
});
