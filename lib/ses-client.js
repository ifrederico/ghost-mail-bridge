var { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
var config = require('./config');

var sesClient = new SESClient({
  region: config.awsRegion,
  credentials: {
    accessKeyId: config.awsAccessKeyId,
    secretAccessKey: config.awsSecretAccessKey
  }
});

function sendRawEmail(rawMessage, configurationSetName) {
  var command = new SendRawEmailCommand({
    RawMessage: { Data: Buffer.from(rawMessage) },
    ConfigurationSetName: configurationSetName
  });
  return sesClient.send(command).then(function(response) {
    return { messageId: response.MessageId };
  });
}

module.exports = {
  sendRawEmail: sendRawEmail
};
