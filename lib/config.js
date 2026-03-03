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
  if (!path) path = '/ghost/email';
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\/+$/, '');
  if (!path) path = '/ghost/email';
  return path;
}

var config = {
  port: parsePositiveInt(process.env.PORT, 3003),
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  sesConfigurationSet: process.env.SES_CONFIGURATION_SET || 'ghost-mail-bridge',
  sqsQueueUrl: process.env.SQS_QUEUE_URL,
  proxyApiKey: process.env.PROXY_API_KEY,
  mailgunDomain: process.env.MAILGUN_DOMAIN,
  logLevel: process.env.LOG_LEVEL || 'info',
  sendConcurrency: parsePositiveInt(process.env.SEND_CONCURRENCY, 10),
  sesSendMaxRetries: parseNonNegativeInt(process.env.SES_SEND_MAX_RETRIES, 3),
  sesRetryBaseMs: parsePositiveInt(process.env.SES_RETRY_BASE_MS, 500),
  sesRetryMaxMs: parsePositiveInt(process.env.SES_RETRY_MAX_MS, 10000),
  suppressionRetentionDays: parseNonNegativeInt(process.env.SUPPRESSION_RETENTION_DAYS, 0),
  maxRequestBytes: parsePositiveInt(process.env.MAX_REQUEST_BYTES, 10 * 1024 * 1024),
  maxFormFields: parsePositiveInt(process.env.MAX_FORM_FIELDS, 2000),
  maxFieldSizeBytes: parsePositiveInt(process.env.MAX_FIELD_SIZE_BYTES, 2 * 1024 * 1024),
  maxRecipients: parsePositiveInt(process.env.MAX_RECIPIENTS, 50000),
  maxCustomHeaders: parsePositiveInt(process.env.MAX_CUSTOM_HEADERS, 100),
  adminBasePath: normalizePath(process.env.ADMIN_BASE_PATH, '/ghost/email'),
  ghostAdminUrl: (process.env.GHOST_ADMIN_URL || '').trim(),
  ghostAcceptVersion: (process.env.GHOST_ACCEPT_VERSION || 'v6.0').trim(),
  dbPath: (process.env.DB_PATH || '').trim(),
  disableSqsPoller: parseBoolean(process.env.DISABLE_SQS_POLLER, false)
};

var required = [
  ['AWS_ACCESS_KEY_ID', config.awsAccessKeyId],
  ['AWS_SECRET_ACCESS_KEY', config.awsSecretAccessKey],
  ['SQS_QUEUE_URL', config.sqsQueueUrl],
  ['PROXY_API_KEY', config.proxyApiKey],
  ['MAILGUN_DOMAIN', config.mailgunDomain]
];

var missing = required.filter(function(pair) { return !pair[1]; });
if (missing.length > 0) {
  console.error('Missing required environment variables: ' + missing.map(function(p) { return p[0]; }).join(', '));
  process.exit(1);
}

module.exports = config;
