var crypto = require('crypto');
var config = require('./config');
var { createBatchWithJob, setSendJobRetryState } = require('./db');
var { sendMessage } = require('./sqs-client');
var { parseFormData, normalizeSendRequest } = require('./newsletter-message');

async function handleSendEmail(req, res) {
  try {
    var fields = await parseFormData(req);
    var domain = req.params.domain || config.mailgunDomain;
    var batch = normalizeSendRequest(fields, domain);
    var batchRecord = {
      batchId: crypto.randomUUID(),
      jobId: crypto.randomUUID(),
      batchMessageId: batch.batchMessageId,
      domain: batch.domain,
      ghostEmailId: batch.emailId,
      from: batch.from,
      subject: batch.subject,
      html: batch.html,
      text: batch.text,
      replyTo: batch.replyTo,
      sender: batch.sender,
      listUnsubscribe: batch.listUnsubscribeTemplate,
      listUnsubscribePost: batch.listUnsubscribePostTemplate,
      customHeadersJson: JSON.stringify(batch.customHeaders || {}),
      recipientVariablesJson: JSON.stringify(batch.recipientVars || {}),
      tagsJson: batch.tagsJson,
      recipientsJson: JSON.stringify(batch.recipients || []),
      totalRecipients: batch.recipients.length
    };

    await createBatchWithJob(batchRecord);

    try {
      await sendMessage(config.newsletterSendQueueUrl, {
        jobId: batchRecord.jobId,
        batchId: batchRecord.batchId,
        batchMessageId: batchRecord.batchMessageId
      });
    } catch (queueErr) {
      await setSendJobRetryState(batchRecord.jobId, batchRecord.batchId, {
        status: 'failed',
        queuedRecipients: batchRecord.totalRecipients,
        sentRecipients: 0,
        failedRecipients: 0,
        lastError: queueErr && queueErr.message ? queueErr.message : String(queueErr)
      });

      throw queueErr;
    }

    res.json({
      id: batch.batchMessageId,
      message: 'Queued. Thank you.'
    });
  } catch (err) {
    var status = err && err.status ? err.status : 500;
    var message = err && err.message ? err.message : 'Unknown error';
    console.error('Send email error:', message);

    if (status >= 500) {
      return res.status(status).json({ message: 'Internal server error: ' + message });
    }

    return res.status(status).json({ message: message });
  }
}

module.exports = handleSendEmail;
