var { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
var crypto = require('crypto');
var config = require('./config');
var { insertEvent, insertSuppression, lookupRecipientEmail } = require('./db');
var mapSesEvent = require('./event-mapper');

var sqsClient = new SQSClient({
  region: config.awsRegion,
  credentials: {
    accessKeyId: config.awsAccessKeyId,
    secretAccessKey: config.awsSecretAccessKey
  }
});

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

  // SNS envelope: { Type: 'Notification', Message: '...' }
  if (parsed.Type === 'Notification' && parsed.Message) {
    return {
      sesEvent: JSON.parse(parsed.Message),
      sourceMessageId: parsed.MessageId ? 'sns:' + parsed.MessageId : 'sns-body:' + sha256Hex(parsed.Message)
    };
  }

  // Raw SES event
  if (parsed.eventType) {
    return {
      sesEvent: parsed,
      sourceMessageId: 'raw:' + sha256Hex(body)
    };
  }

  return null;
}

function processEvent(normalized, sourceMessageId) {
  var batchMessageId = normalized.batch_message_id;
  var ghostEmailId = normalized.ghost_email_id;
  var tags = null;

  // Try DB correlation via ses_message_id
  if (normalized.ses_message_id) {
    var row = lookupRecipientEmail.get(normalized.ses_message_id);
    if (row) {
      batchMessageId = stripAngleBrackets(row.batch_message_id);
      ghostEmailId = row.ghost_email_id || ghostEmailId;
      tags = row.tags;
    }
  }

  // Ensure batch_message_id has no angle brackets
  batchMessageId = stripAngleBrackets(batchMessageId);

  var eventId = buildEventId(normalized, sourceMessageId);

  insertEvent.run(
    eventId,
    normalized.event_type,
    normalized.severity,
    normalized.recipient,
    normalized.timestamp,
    batchMessageId,
    ghostEmailId,
    normalized.delivery_status_code,
    normalized.delivery_status_message,
    normalized.delivery_status_enhanced,
    tags || '[]'
  );

  if (normalized.is_suppression) {
    insertSuppression.run(
      normalized.recipient,
      normalized.suppression_type,
      normalized.suppression_reason
    );
    console.log('Suppression recorded: ' + normalized.suppression_type + ' for ' + normalized.recipient);
  }
}

function deleteMessage(receiptHandle) {
  var command = new DeleteMessageCommand({
    QueueUrl: config.sqsQueueUrl,
    ReceiptHandle: receiptHandle
  });
  return sqsClient.send(command);
}

function pollOnce() {
  var command = new ReceiveMessageCommand({
    QueueUrl: config.sqsQueueUrl,
    WaitTimeSeconds: 20,
    MaxNumberOfMessages: 10
  });

  return sqsClient.send(command).then(function(response) {
    var messages = response.Messages || [];

    if (messages.length === 0) return;

    console.log('SQS: received ' + messages.length + ' message(s)');

    var chain = Promise.resolve();

    for (var i = 0; i < messages.length; i++) {
      (function(msg) {
        chain = chain.then(function() {
          var parsedBody;
          try {
            parsedBody = parseSqsBody(msg.Body);
          } catch (e) {
            console.error('SQS: failed to parse message body:', e.message);
            return deleteMessage(msg.ReceiptHandle);
          }

          if (!parsedBody || !parsedBody.sesEvent) {
            console.warn('SQS: unrecognized message format, deleting');
            return deleteMessage(msg.ReceiptHandle);
          }

          var sesEvent = parsedBody.sesEvent;
          var sourceMessageId = parsedBody.sourceMessageId;
          var normalized = mapSesEvent(sesEvent);

          for (var j = 0; j < normalized.length; j++) {
            processEvent(normalized[j], sourceMessageId);
          }

          if (normalized.length > 0) {
            console.log('SQS: stored ' + normalized.length + ' event(s) [' + sesEvent.eventType + ']');
          }

          return deleteMessage(msg.ReceiptHandle);
        });
      })(messages[i]);
    }

    return chain;
  });
}

function startPolling() {
  console.log('SQS poller started (queue: ' + config.sqsQueueUrl + ')');

  function loop() {
    pollOnce().then(function() {
      loop();
    }).catch(function(err) {
      console.error('SQS poller error:', err.message);
      setTimeout(loop, 5000);
    });
  }

  loop();
}

module.exports = { startPolling: startPolling };
