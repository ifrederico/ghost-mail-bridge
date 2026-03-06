var config = require('../../config');
var {
  claimSendJob,
  getSendJobWithBatch,
  setSendJobResult,
  setSendJobRetryState,
  recordRecipientEmail,
  getExistingRecipientsForBatch,
  insertEvent
} = require('../../db');
var { receiveMessages, deleteMessage } = require('../../sqs-client');
var {
  buildImmediateSendFailureEvent,
  chunkRecipients
} = require('../../newsletter-message');

var MAX_SENDING_CONCURRENCY = 2;

async function runWithConcurrency(items, concurrency, handler) {
  var queue = items.slice();
  var workers = [];
  var limit = Math.max(1, concurrency);

  async function worker() {
    while (queue.length > 0) {
      var item = queue.shift();
      await handler(item);
    }
  }

  for (var i = 0; i < limit; i += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch (_err) {
    return fallback;
  }
}

function hydrateBatch(row) {
  return {
    batchId: row.batch_id,
    batchMessageId: row.batch_message_id,
    emailId: row.ghost_email_id || '',
    from: row.from_header,
    subject: row.subject,
    html: row.html_body || '',
    text: row.text_body || '',
    replyTo: row.reply_to || '',
    sender: row.sender || '',
    listUnsubscribeTemplate: row.list_unsubscribe_template || '',
    listUnsubscribePostTemplate: row.list_unsubscribe_post_template || '',
    customHeaders: parseJson(row.custom_headers_json, {}),
    recipientVars: parseJson(row.recipient_variables_json, {}),
    recipients: parseJson(row.recipients_json, []),
    tagsJson: row.tags_json || '[]'
  };
}

class BatchSendingService {
  constructor(dependencies) {
    this.emailProvider = dependencies.emailProvider;
    this.state = {
      startedAt: null,
      lastPollStartedAt: null,
      lastPollFinishedAt: null,
      lastErrorAt: null,
      lastErrorMessage: '',
      lastMessagesReceived: 0,
      totalMessagesReceived: 0,
      totalJobsProcessed: 0,
      totalRecipientsSent: 0,
      totalRecipientsFailed: 0,
      isRunning: false
    };
  }

  getState() {
    return {
      startedAt: this.state.startedAt,
      lastPollStartedAt: this.state.lastPollStartedAt,
      lastPollFinishedAt: this.state.lastPollFinishedAt,
      lastErrorAt: this.state.lastErrorAt,
      lastErrorMessage: this.state.lastErrorMessage,
      lastMessagesReceived: this.state.lastMessagesReceived,
      totalMessagesReceived: this.state.totalMessagesReceived,
      totalJobsProcessed: this.state.totalJobsProcessed,
      totalRecipientsSent: this.state.totalRecipientsSent,
      totalRecipientsFailed: this.state.totalRecipientsFailed,
      isRunning: this.state.isRunning
    };
  }

  async processJob(jobId, workerInstanceId) {
    var claim = await claimSendJob(jobId, workerInstanceId);
    if (!claim.claimed) {
      return {
        skipped: true,
        reason: claim.reason || 'unknown',
        sentRecipients: 0,
        failedRecipients: 0
      };
    }

    var row = await getSendJobWithBatch(jobId);
    if (!row) {
      throw new Error('Missing send job after claim: ' + jobId);
    }

    var batch = hydrateBatch(row);
    var existingRecipients = new Set(await getExistingRecipientsForBatch(batch.batchMessageId));
    var recipientsToSend = batch.recipients.filter(function(recipient) {
      return !existingRecipients.has(recipient);
    });
    var chunks = chunkRecipients(recipientsToSend, this.emailProvider.getMaximumRecipients());
    var progress = {
      sentRecipients: existingRecipients.size,
      totalRecipients: batch.recipients.length
    };

    try {
      await this.sendBatches(batch, chunks, existingRecipients, progress);

      var finalSent = existingRecipients.size;
      var finalFailed = Math.max(0, batch.recipients.length - finalSent);
      var finalStatus = finalFailed === 0 ? 'completed' : (finalSent === 0 ? 'failed' : 'partial');
      var finalError = finalFailed > 0 ? 'One or more recipients failed to send' : null;

      await setSendJobResult(jobId, batch.batchId, {
        status: finalStatus,
        queuedRecipients: 0,
        sentRecipients: finalSent,
        failedRecipients: finalFailed,
        lastError: finalError
      });

      return {
        skipped: false,
        sentRecipients: finalSent,
        failedRecipients: finalFailed
      };
    } catch (err) {
      var queuedRecipients = Math.max(0, progress.totalRecipients - progress.sentRecipients);
      var retryStatus = progress.sentRecipients > 0 ? 'partial' : 'failed';
      var errorMessage = err && err.message ? err.message : String(err);

      await setSendJobRetryState(jobId, batch.batchId, {
        status: retryStatus,
        queuedRecipients: queuedRecipients,
        sentRecipients: progress.sentRecipients,
        failedRecipients: 0,
        lastError: errorMessage
      });

      throw err;
    }
  }

  async sendBatches(batch, batches, existingRecipients, progress) {
    var self = this;
    var batchConcurrency = Math.max(1, Math.min(config.sendBatchConcurrency, MAX_SENDING_CONCURRENCY));

    await runWithConcurrency(batches, batchConcurrency, async function(recipientBatch) {
      await self.emailProvider.send(batch, recipientBatch, {
        onSuccess: async function(recipient, outcome) {
          await recordRecipientEmail({
            sesMessageId: outcome.result.messageId,
            batchMessageId: batch.batchMessageId,
            recipient: recipient,
            ghostEmailId: batch.emailId,
            tagsJson: batch.tagsJson
          });

          existingRecipients.add(recipient);
          progress.sentRecipients = existingRecipients.size;

          if (config.logLevel === 'debug') {
            var retriesUsed = outcome.attempts > 1 ? ' after ' + (outcome.attempts - 1) + ' retry(s)' : '';
            console.log('Sent to ' + recipient + ' (SES ID: ' + outcome.result.messageId + ')' + retriesUsed);
          }
        },
        onFailure: async function(recipient, err) {
          var errorMessage = err && err.message ? err.message : String(err);
          console.error('Failed to send to ' + recipient + ': ' + errorMessage);
          await insertEvent(buildImmediateSendFailureEvent({
            batchMessageId: batch.batchMessageId,
            recipient: recipient,
            emailId: batch.emailId,
            tagsJson: batch.tagsJson,
            err: err,
            errorMessage: errorMessage
          }));
        }
      });
    });
  }

  async pollOnce(workerInstanceId) {
    var messages = await receiveMessages(
      config.newsletterSendQueueUrl,
      config.sendWorkerPollBatchSize,
      config.sendWorkerPollWaitSeconds
    );

    if (messages.length === 0) {
      return {
        messagesReceived: 0,
        jobsProcessed: 0,
        sentRecipients: 0,
        failedRecipients: 0
      };
    }

    var summary = {
      messagesReceived: messages.length,
      jobsProcessed: 0,
      sentRecipients: 0,
      failedRecipients: 0
    };

    for (var i = 0; i < messages.length; i += 1) {
      var message = messages[i];
      var parsed;

      try {
        parsed = JSON.parse(message.Body || '{}');
      } catch (err) {
        console.error('Newsletter worker: failed to parse queue message:', err.message || String(err));
        await deleteMessage(config.newsletterSendQueueUrl, message.ReceiptHandle);
        continue;
      }

      if (!parsed.jobId) {
        console.warn('Newsletter worker: queue message missing jobId, deleting');
        await deleteMessage(config.newsletterSendQueueUrl, message.ReceiptHandle);
        continue;
      }

      var result = await this.processJob(parsed.jobId, workerInstanceId);
      await deleteMessage(config.newsletterSendQueueUrl, message.ReceiptHandle);

      if (!result.skipped) {
        summary.jobsProcessed += 1;
        summary.sentRecipients += result.sentRecipients;
        summary.failedRecipients += result.failedRecipients;
      }
    }

    return summary;
  }

  start(workerInstanceId) {
    var self = this;
    var stopped = false;

    this.state.startedAt = new Date().toISOString();
    this.state.isRunning = true;
    this.state.lastErrorAt = null;
    this.state.lastErrorMessage = '';

    console.log('Newsletter worker started (queue: ' + config.newsletterSendQueueUrl + ')');

    async function loop() {
      if (stopped) return;

      self.state.lastPollStartedAt = new Date().toISOString();

      try {
        var summary = await self.pollOnce(workerInstanceId);
        self.state.lastPollFinishedAt = new Date().toISOString();
        self.state.lastMessagesReceived = summary.messagesReceived;
        self.state.totalMessagesReceived += summary.messagesReceived;
        self.state.totalJobsProcessed += summary.jobsProcessed;
        self.state.totalRecipientsSent += summary.sentRecipients;
        self.state.totalRecipientsFailed += summary.failedRecipients;
      } catch (err) {
        self.state.lastErrorAt = new Date().toISOString();
        self.state.lastErrorMessage = err && err.message ? err.message : String(err);
        console.error('Newsletter worker error:', self.state.lastErrorMessage);
        await new Promise(function(resolve) {
          setTimeout(resolve, 5000);
        });
      }

      if (!stopped) {
        return loop();
      }
    }

    loop();

    return function stop() {
      stopped = true;
      self.state.isRunning = false;
    };
  }
}

module.exports = BatchSendingService;
