var crypto = require('crypto');
var config = require('./config');
var { insertEvent, upsertSuppression, lookupRecipientEmail } = require('./db');
var { receiveMessages, deleteMessage } = require('./sqs-client');
var mapSesEvent = require('./event-mapper');

var pollerState = {
  startedAt: null,
  lastPollStartedAt: null,
  lastPollFinishedAt: null,
  lastErrorAt: null,
  lastErrorMessage: '',
  lastMessagesReceived: 0,
  totalMessagesReceived: 0,
  totalEventsStored: 0,
  isRunning: false
};

function getPollerState() {
  return {
    startedAt: pollerState.startedAt,
    lastPollStartedAt: pollerState.lastPollStartedAt,
    lastPollFinishedAt: pollerState.lastPollFinishedAt,
    lastErrorAt: pollerState.lastErrorAt,
    lastErrorMessage: pollerState.lastErrorMessage,
    lastMessagesReceived: pollerState.lastMessagesReceived,
    totalMessagesReceived: pollerState.totalMessagesReceived,
    totalEventsStored: pollerState.totalEventsStored,
    isRunning: pollerState.isRunning
  };
}

function stripAngleBrackets(str) {
  if (!str) return str;
  return str.replace(/^</, '').replace(/>$/, '');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function buildEventId(normalized, sourceMessageId) {
  var parts = [
    sourceMessageId || '',
    normalized.event_type || '',
    normalized.recipient || '',
    String(normalized.timestamp || ''),
    normalized.ses_message_id || '',
    normalized.batch_message_id || '',
    normalized.delivery_status_code === null || normalized.delivery_status_code === undefined ? '' : String(normalized.delivery_status_code),
    normalized.delivery_status_enhanced || ''
  ];

  return sha256Hex(parts.join('|'));
}

function parseSqsBody(body) {
  var parsed = JSON.parse(body);

  if (parsed.Type === 'Notification' && parsed.Message) {
    return {
      sesEvent: JSON.parse(parsed.Message),
      sourceMessageId: parsed.MessageId ? 'sns:' + parsed.MessageId : 'sns-body:' + sha256Hex(parsed.Message)
    };
  }

  if (parsed.eventType) {
    return {
      sesEvent: parsed,
      sourceMessageId: 'raw:' + sha256Hex(body)
    };
  }

  return null;
}

async function processEvent(normalized, sourceMessageId) {
  var batchMessageId = normalized.batch_message_id;
  var ghostEmailId = normalized.ghost_email_id;
  var tagsJson = '[]';

  if (normalized.ses_message_id) {
    var row = await lookupRecipientEmail(normalized.ses_message_id);
    if (row) {
      batchMessageId = stripAngleBrackets(row.batch_message_id);
      ghostEmailId = row.ghost_email_id || ghostEmailId;
      tagsJson = row.tags_json || tagsJson;
    }
  }

  await insertEvent({
    id: buildEventId(normalized, sourceMessageId),
    eventType: normalized.event_type,
    severity: normalized.severity,
    recipient: normalized.recipient,
    timestamp: normalized.timestamp,
    messageId: stripAngleBrackets(batchMessageId),
    emailId: ghostEmailId,
    deliveryStatusCode: normalized.delivery_status_code,
    deliveryStatusMessage: normalized.delivery_status_message,
    deliveryStatusEnhanced: normalized.delivery_status_enhanced,
    tagsJson: tagsJson
  });

  if (normalized.is_suppression) {
    await upsertSuppression(
      normalized.recipient,
      normalized.suppression_type,
      normalized.suppression_reason
    );
    console.log('Suppression recorded: ' + normalized.suppression_type + ' for ' + normalized.recipient);
  }
}

async function pollOnce() {
  var messages = await receiveMessages(
    config.sesEventsQueueUrl,
    config.eventPollBatchSize,
    config.eventPollWaitSeconds
  );

  if (messages.length === 0) {
    return { messagesReceived: 0, eventsStored: 0 };
  }

  console.log('SQS: received ' + messages.length + ' SES event message(s)');

  var eventsStored = 0;

  for (var i = 0; i < messages.length; i += 1) {
    var msg = messages[i];
    var parsedBody;

    try {
      parsedBody = parseSqsBody(msg.Body);
    } catch (err) {
      console.error('SQS: failed to parse SES event body:', err.message);
      await deleteMessage(config.sesEventsQueueUrl, msg.ReceiptHandle);
      continue;
    }

    if (!parsedBody || !parsedBody.sesEvent) {
      console.warn('SQS: unrecognized SES event format, deleting');
      await deleteMessage(config.sesEventsQueueUrl, msg.ReceiptHandle);
      continue;
    }

    var sesEvent = parsedBody.sesEvent;
    var sourceMessageId = parsedBody.sourceMessageId;
    var normalized = mapSesEvent(sesEvent);

    for (var j = 0; j < normalized.length; j += 1) {
      await processEvent(normalized[j], sourceMessageId);
    }

    eventsStored += normalized.length;

    if (normalized.length > 0) {
      console.log('SQS: stored ' + normalized.length + ' event(s) [' + sesEvent.eventType + ']');
    }

    await deleteMessage(config.sesEventsQueueUrl, msg.ReceiptHandle);
  }

  return {
    messagesReceived: messages.length,
    eventsStored: eventsStored
  };
}

function startPolling() {
  var stopped = false;
  pollerState.startedAt = new Date().toISOString();
  pollerState.isRunning = true;
  pollerState.lastErrorAt = null;
  pollerState.lastErrorMessage = '';

  console.log('SES event poller started (queue: ' + config.sesEventsQueueUrl + ')');

  async function loop() {
    if (stopped) return;

    pollerState.lastPollStartedAt = new Date().toISOString();

    try {
      var summary = await pollOnce();
      pollerState.lastPollFinishedAt = new Date().toISOString();
      pollerState.lastMessagesReceived = summary.messagesReceived;
      pollerState.totalMessagesReceived += summary.messagesReceived;
      pollerState.totalEventsStored += summary.eventsStored;
    } catch (err) {
      pollerState.lastErrorAt = new Date().toISOString();
      pollerState.lastErrorMessage = err && err.message ? err.message : String(err);
      console.error('SES event poller error:', pollerState.lastErrorMessage);
      await new Promise(function(resolve) {
        setTimeout(resolve, 5000);
      });
    }

    if (!stopped) {
      return loop();
    }
  }

  loop();

  return function stopPolling() {
    stopped = true;
    pollerState.isRunning = false;
  };
}

module.exports = {
  startPolling: startPolling,
  getPollerState: getPollerState
};
