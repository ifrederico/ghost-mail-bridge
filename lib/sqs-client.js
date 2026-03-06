var {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand
} = require('@aws-sdk/client-sqs');
var config = require('./config');

var sqsClient = new SQSClient({
  region: config.awsRegion,
  credentials: {
    accessKeyId: config.awsAccessKeyId,
    secretAccessKey: config.awsSecretAccessKey
  }
});

async function sendMessage(queueUrl, body) {
  var response = await sqsClient.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: typeof body === 'string' ? body : JSON.stringify(body)
  }));

  return {
    messageId: response.MessageId || ''
  };
}

async function receiveMessages(queueUrl, maxNumberOfMessages, waitTimeSeconds) {
  var response = await sqsClient.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    WaitTimeSeconds: waitTimeSeconds,
    MaxNumberOfMessages: maxNumberOfMessages
  }));

  return response.Messages || [];
}

async function deleteMessage(queueUrl, receiptHandle) {
  await sqsClient.send(new DeleteMessageCommand({
    QueueUrl: queueUrl,
    ReceiptHandle: receiptHandle
  }));
}

async function getQueueDepth(queueUrl) {
  var response = await sqsClient.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: [
      'ApproximateNumberOfMessages',
      'ApproximateNumberOfMessagesNotVisible',
      'ApproximateNumberOfMessagesDelayed'
    ]
  }));

  var attributes = response.Attributes || {};

  return {
    visible: parseInt(attributes.ApproximateNumberOfMessages || '0', 10) || 0,
    inFlight: parseInt(attributes.ApproximateNumberOfMessagesNotVisible || '0', 10) || 0,
    delayed: parseInt(attributes.ApproximateNumberOfMessagesDelayed || '0', 10) || 0
  };
}

module.exports = {
  sendMessage: sendMessage,
  receiveMessages: receiveMessages,
  deleteMessage: deleteMessage,
  getQueueDepth: getQueueDepth
};
