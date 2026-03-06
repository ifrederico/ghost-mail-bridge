var config = require('../../config');
var { sendRecipient } = require('../../newsletter-message');

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

class MailgunClient {
  static DEFAULT_BATCH_SIZE = 1000;

  getBatchSize() {
    return config.sendBatchSize || MailgunClient.DEFAULT_BATCH_SIZE;
  }

  async send(batch, recipients, handlers) {
    var onSuccess = handlers && typeof handlers.onSuccess === 'function' ? handlers.onSuccess : async function() {};
    var onFailure = handlers && typeof handlers.onFailure === 'function' ? handlers.onFailure : async function() {};

    await runWithConcurrency(recipients, config.sendConcurrency, async function(recipient) {
      try {
        var outcome = await sendRecipient(batch, recipient);
        await onSuccess(recipient, outcome);
      } catch (err) {
        await onFailure(recipient, err);
      }
    });
  }
}

module.exports = MailgunClient;
