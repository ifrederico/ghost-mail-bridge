var MailgunClient = require('./services/lib/mailgun-client');
var MailgunEmailProvider = require('./services/email-service/mailgun-email-provider');
var BatchSendingService = require('./services/email-service/batch-sending-service');

var batchSendingService = new BatchSendingService({
  emailProvider: new MailgunEmailProvider({
    mailgunClient: new MailgunClient()
  })
});

function getWorkerState() {
  return batchSendingService.getState();
}

function startNewsletterWorker(workerInstanceId) {
  return batchSendingService.start(workerInstanceId);
}

module.exports = {
  startNewsletterWorker: startNewsletterWorker,
  getWorkerState: getWorkerState
};
