class MailgunEmailProvider {
  constructor(dependencies) {
    this.mailgunClient = dependencies.mailgunClient;
  }

  getMaximumRecipients() {
    return this.mailgunClient.getBatchSize();
  }

  async send(batch, recipients, handlers) {
    return this.mailgunClient.send(batch, recipients, handlers);
  }
}

module.exports = MailgunEmailProvider;
