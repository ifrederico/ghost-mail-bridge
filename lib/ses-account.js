var { SESv2Client, GetAccountCommand } = require('@aws-sdk/client-sesv2');
var config = require('./config');

var sesv2Client = new SESv2Client({
  region: config.awsRegion,
  credentials: {
    accessKeyId: config.awsAccessKeyId,
    secretAccessKey: config.awsSecretAccessKey
  }
});

var CACHE_TTL_MS = 60000;
var cache = {
  value: null,
  expiresAt: 0,
  pending: null
};

function toQuotaNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  var parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildUnavailableStatus(message) {
  return {
    available: false,
    mode: 'unknown',
    productionAccessEnabled: null,
    sendingEnabled: null,
    enforcementStatus: '',
    sendQuota: {
      max24HourSend: null,
      maxSendRate: null,
      sentLast24Hours: null
    },
    checkedAt: new Date().toISOString(),
    error: message || 'Unable to read SES account status'
  };
}

function normalizeAccountStatus(response) {
  var productionAccessEnabled = response && response.ProductionAccessEnabled === true;
  var sendingEnabled = response && response.SendingEnabled !== false;

  return {
    available: true,
    mode: productionAccessEnabled ? 'production' : 'sandbox',
    productionAccessEnabled: productionAccessEnabled,
    sendingEnabled: sendingEnabled,
    enforcementStatus: response && response.EnforcementStatus ? String(response.EnforcementStatus) : '',
    sendQuota: {
      max24HourSend: toQuotaNumber(response && response.SendQuota ? response.SendQuota.Max24HourSend : null),
      maxSendRate: toQuotaNumber(response && response.SendQuota ? response.SendQuota.MaxSendRate : null),
      sentLast24Hours: toQuotaNumber(response && response.SendQuota ? response.SendQuota.SentLast24Hours : null)
    },
    checkedAt: new Date().toISOString(),
    error: ''
  };
}

async function getSesAccountStatus(options) {
  var force = options && options.force === true;
  var now = Date.now();

  if (!force && cache.value && cache.expiresAt > now) {
    return cache.value;
  }

  if (!force && cache.pending) {
    return cache.pending;
  }

  cache.pending = sesv2Client.send(new GetAccountCommand({})).then(function(response) {
    var status = normalizeAccountStatus(response);
    cache.value = status;
    cache.expiresAt = Date.now() + CACHE_TTL_MS;
    return status;
  }).catch(function(err) {
    var message = err && err.message ? err.message : String(err);
    var status = buildUnavailableStatus(message);
    cache.value = status;
    cache.expiresAt = Date.now() + CACHE_TTL_MS;
    return status;
  }).finally(function() {
    cache.pending = null;
  });

  return cache.pending;
}

module.exports = {
  getSesAccountStatus: getSesAccountStatus
};
