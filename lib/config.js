function parsePositiveInt(value, fallback) {
  var parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeInt(value, fallback) {
  var parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  var normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function normalizePath(value, fallback) {
  var path = (value || fallback || '').trim();
  if (!path) path = '/ghost/mail';
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\/+$/, '');
  if (!path) path = '/ghost/mail';
  return path;
}

function normalizeOptionalUrl(value, envName) {
  var raw = (value || '').trim();
  var parsed;

  if (!raw) return '';

  try {
    parsed = new URL(raw);
  } catch (_err) {
    console.error(envName + ' must be a full http(s) URL');
    process.exit(1);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(envName + ' must use http:// or https://');
    process.exit(1);
  }

  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function parseRuntimeRole(value) {
  var normalized = String(value || 'all').trim().toLowerCase();
  if (normalized === 'api' || normalized === 'worker' || normalized === 'all') {
    return normalized;
  }

  console.error('APP_ROLE must be one of: api, worker, all');
  process.exit(1);
}

function roleIncludesApi(role) {
  return role === 'api' || role === 'all';
}

function roleIncludesWorker(role) {
  return role === 'worker' || role === 'all';
}

var config = {
  port: parsePositiveInt(process.env.PORT, 3003),
  runtimeRole: parseRuntimeRole(process.env.APP_ROLE),
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  sesConfigurationSet: process.env.SES_CONFIGURATION_SET || 'ghost-mail-bridge',
  sesEventsQueueUrl: (process.env.SES_EVENTS_QUEUE_URL || process.env.SQS_QUEUE_URL || '').trim(),
  newsletterSendQueueUrl: (process.env.NEWSLETTER_SEND_QUEUE_URL || '').trim(),
  newsletterSendDlqUrl: (process.env.NEWSLETTER_SEND_DLQ_URL || '').trim(),
  proxyApiKey: process.env.PROXY_API_KEY,
  mailgunDomain: process.env.MAILGUN_DOMAIN,
  databaseUrl: (process.env.DATABASE_URL || '').trim(),
  dbConnectionLimit: parsePositiveInt(process.env.DB_CONNECTION_LIMIT, 10),
  dbConnectTimeoutMs: parsePositiveInt(process.env.DB_CONNECT_TIMEOUT_MS, 10000),
  logLevel: process.env.LOG_LEVEL || 'info',
  sendConcurrency: parsePositiveInt(process.env.SEND_CONCURRENCY, 10),
  sendBatchSize: parsePositiveInt(process.env.SEND_BATCH_SIZE, 1000),
  sendBatchConcurrency: parsePositiveInt(process.env.SEND_BATCH_CONCURRENCY, 2),
  sendWorkerPollWaitSeconds: parsePositiveInt(process.env.SEND_WORKER_POLL_WAIT_SECONDS, 20),
  sendWorkerPollBatchSize: parsePositiveInt(process.env.SEND_WORKER_POLL_BATCH_SIZE, 1),
  eventPollWaitSeconds: parsePositiveInt(process.env.EVENT_POLL_WAIT_SECONDS, 20),
  eventPollBatchSize: parsePositiveInt(process.env.EVENT_POLL_BATCH_SIZE, 10),
  heartbeatIntervalMs: parsePositiveInt(process.env.RUNTIME_HEARTBEAT_INTERVAL_MS, 15000),
  runtimeHeartbeatStaleSeconds: parsePositiveInt(process.env.RUNTIME_HEARTBEAT_STALE_SECONDS, 60),
  cleanupIntervalMs: parsePositiveInt(process.env.CLEANUP_INTERVAL_MS, 86400000),
  batchRetentionDays: parsePositiveInt(process.env.BATCH_RETENTION_DAYS, 90),
  eventRetentionDays: parsePositiveInt(process.env.EVENT_RETENTION_DAYS, 90),
  suppressionRetentionDays: parseNonNegativeInt(process.env.SUPPRESSION_RETENTION_DAYS, 0),
  sesSendMaxRetries: parseNonNegativeInt(process.env.SES_SEND_MAX_RETRIES, 3),
  sesRetryBaseMs: parsePositiveInt(process.env.SES_RETRY_BASE_MS, 500),
  sesRetryMaxMs: parsePositiveInt(process.env.SES_RETRY_MAX_MS, 10000),
  maxRequestBytes: parsePositiveInt(process.env.MAX_REQUEST_BYTES, 10 * 1024 * 1024),
  maxFormFields: parsePositiveInt(process.env.MAX_FORM_FIELDS, 2000),
  maxFieldSizeBytes: parsePositiveInt(process.env.MAX_FIELD_SIZE_BYTES, 2 * 1024 * 1024),
  maxRecipients: parsePositiveInt(process.env.MAX_RECIPIENTS, 50000),
  maxCustomHeaders: parsePositiveInt(process.env.MAX_CUSTOM_HEADERS, 100),
  adminBasePath: normalizePath(process.env.ADMIN_BASE_PATH, '/ghost/mail'),
  ghostAdminUrl: normalizeOptionalUrl(process.env.GHOST_ADMIN_URL, 'GHOST_ADMIN_URL'),
  allowInsecureGhostAdminUrl: parseBoolean(process.env.ALLOW_INSECURE_GHOST_ADMIN_URL, false),
  ghostAcceptVersion: (process.env.GHOST_ACCEPT_VERSION || 'v6.0').trim(),
  disableAdminAuth: parseBoolean(process.env.DISABLE_ADMIN_AUTH, false),
  disableSesEventPoller: parseBoolean(
    process.env.DISABLE_SES_EVENT_POLLER !== undefined
      ? process.env.DISABLE_SES_EVENT_POLLER
      : process.env.DISABLE_SQS_POLLER,
    false
  ),
  disableNewsletterWorker: parseBoolean(process.env.DISABLE_NEWSLETTER_WORKER, false)
};

var required = [
  ['AWS_ACCESS_KEY_ID', config.awsAccessKeyId],
  ['AWS_SECRET_ACCESS_KEY', config.awsSecretAccessKey],
  ['DATABASE_URL', config.databaseUrl]
];

if (roleIncludesApi(config.runtimeRole)) {
  required.push(['NEWSLETTER_SEND_QUEUE_URL', config.newsletterSendQueueUrl]);
  required.push(['PROXY_API_KEY', config.proxyApiKey]);
  required.push(['MAILGUN_DOMAIN', config.mailgunDomain]);
}

if (roleIncludesWorker(config.runtimeRole) && !config.disableNewsletterWorker) {
  required.push(['NEWSLETTER_SEND_QUEUE_URL', config.newsletterSendQueueUrl]);
}

if (roleIncludesWorker(config.runtimeRole) && !config.disableSesEventPoller) {
  required.push(['SES_EVENTS_QUEUE_URL', config.sesEventsQueueUrl]);
}

var missing = required.filter(function(pair) { return !pair[1]; });
if (missing.length > 0) {
  console.error('Missing required environment variables: ' + missing.map(function(p) { return p[0]; }).join(', '));
  process.exit(1);
}

if (config.ghostAdminUrl) {
  var parsedGhostAdminUrl = new URL(config.ghostAdminUrl);
  var insecureGhostAdminUrl = parsedGhostAdminUrl.protocol !== 'https:';

  if (insecureGhostAdminUrl && !isLoopbackHostname(parsedGhostAdminUrl.hostname) && !config.allowInsecureGhostAdminUrl) {
    console.error('GHOST_ADMIN_URL must use https:// unless ALLOW_INSECURE_GHOST_ADMIN_URL is enabled for a trusted local/private setup');
    process.exit(1);
  }
}

module.exports = config;
