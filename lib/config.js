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
  suppressionRetentionDays: parseNonNegativeInt(process.env.SUPPRESSION_RETENTION_DAYS, 0),
  maxRequestBytes: parsePositiveInt(process.env.MAX_REQUEST_BYTES, 10 * 1024 * 1024),
  maxFormFields: parsePositiveInt(process.env.MAX_FORM_FIELDS, 2000),
  maxFieldSizeBytes: parsePositiveInt(process.env.MAX_FIELD_SIZE_BYTES, 2 * 1024 * 1024),
  maxRecipients: parsePositiveInt(process.env.MAX_RECIPIENTS, 50000),
  maxCustomHeaders: parsePositiveInt(process.env.MAX_CUSTOM_HEADERS, 100)
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
