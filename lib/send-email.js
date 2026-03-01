var Busboy = require('busboy');
var crypto = require('crypto');
var config = require('./config');
var { insertMessageMap, insertRecipientEmail } = require('./db');
var { sendRawEmail } = require('./ses-client');
var substituteVars = require('./template-vars');
var HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Simple promise-based semaphore for concurrency limiting
function Semaphore(max) {
  this.max = max;
  this.current = 0;
  this.queue = [];
}

Semaphore.prototype.acquire = function() {
  var self = this;
  if (self.current < self.max) {
    self.current++;
    return Promise.resolve();
  }
  return new Promise(function(resolve) {
    self.queue.push(resolve);
  });
};

Semaphore.prototype.release = function() {
  this.current--;
  if (this.queue.length > 0) {
    this.current++;
    var next = this.queue.shift();
    next();
  }
};

var semaphore = new Semaphore(config.sendConcurrency);

function generateBoundary() {
  return '----=_Part_' + crypto.randomBytes(16).toString('hex');
}

function createRequestError(message, status) {
  var err = new Error(message);
  err.status = status;
  return err;
}

function sanitizeHeaderValue(value, fieldName) {
  var output = String(value === undefined || value === null ? '' : value);
  if (/[\r\n]/.test(output)) {
    throw createRequestError('Invalid header value for ' + fieldName, 400);
  }
  return output;
}

function sanitizeHeaderName(name) {
  if (!HEADER_NAME_PATTERN.test(name)) {
    throw createRequestError('Invalid custom header name: ' + name, 400);
  }
  return name;
}

function buildRawMime(opts) {
  var boundary = generateBoundary();
  var lines = [];

  lines.push('From: ' + opts.from);
  lines.push('To: ' + opts.to);
  lines.push('Subject: ' + opts.subject);

  if (opts.replyTo) {
    lines.push('Reply-To: ' + opts.replyTo);
  }
  if (opts.sender) {
    lines.push('Sender: ' + opts.sender);
  }
  if (opts.messageId) {
    lines.push('Message-ID: ' + opts.messageId);
  }
  if (opts.listUnsubscribe) {
    lines.push('List-Unsubscribe: ' + opts.listUnsubscribe);
  }
  if (opts.listUnsubscribePost) {
    lines.push('List-Unsubscribe-Post: ' + opts.listUnsubscribePost);
  }

  // Custom headers (h:* fields from Ghost)
  if (opts.customHeaders) {
    var keys = Object.keys(opts.customHeaders);
    for (var i = 0; i < keys.length; i++) {
      lines.push(keys[i] + ': ' + opts.customHeaders[keys[i]]);
    }
  }

  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
  lines.push('');

  // text/plain part
  if (opts.text) {
    lines.push('--' + boundary);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(opts.text).toString('base64'));
    lines.push('');
  }

  // text/html part
  if (opts.html) {
    lines.push('--' + boundary);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(opts.html).toString('base64'));
    lines.push('');
  }

  lines.push('--' + boundary + '--');
  lines.push('');

  return lines.join('\r\n');
}

function parseFormData(req) {
  return new Promise(function(resolve, reject) {
    var fields = {};
    var arrayFields = {}; // Fields that should accumulate as arrays
    var settled = false;
    var contentLength = parseInt(req.headers['content-length'] || '', 10);

    if (Number.isFinite(contentLength) && contentLength > config.maxRequestBytes) {
      return reject(createRequestError('Request body too large', 413));
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    function done() {
      if (settled) return;
      settled = true;
      resolve(fields);
    }

    var busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          files: 0,
          fields: config.maxFormFields,
          parts: config.maxFormFields,
          fieldSize: config.maxFieldSizeBytes
        }
      });
    } catch (e) {
      return reject(createRequestError('Invalid multipart form-data: ' + e.message, 400));
    }

    busboy.on('field', function(name, value) {
      // These fields can appear multiple times — accumulate as arrays
      if (name === 'to' || name === 'o:tag') {
        if (!arrayFields[name]) arrayFields[name] = [];
        arrayFields[name].push(value);
      } else {
        fields[name] = value;
      }
    });

    busboy.on('finish', function() {
      // Merge array fields into fields
      var keys = Object.keys(arrayFields);
      for (var i = 0; i < keys.length; i++) {
        fields[keys[i]] = arrayFields[keys[i]];
      }
      done();
    });

    busboy.on('file', function(_name, stream) {
      stream.resume();
      fail(createRequestError('Attachments are not supported', 400));
    });

    busboy.on('fieldsLimit', function() {
      fail(createRequestError('Too many form fields', 413));
    });

    busboy.on('partsLimit', function() {
      fail(createRequestError('Too many form parts', 413));
    });

    busboy.on('filesLimit', function() {
      fail(createRequestError('Attachments are not supported', 400));
    });

    busboy.on('error', function(err) {
      fail(createRequestError('Invalid multipart form-data: ' + err.message, 400));
    });

    req.pipe(busboy);
  });
}

function handleSendEmail(req, res) {
  parseFormData(req).then(function(fields) {
    var from = fields.from;
    var subject = fields.subject;
    var html = fields.html || '';
    var text = fields.text || '';
    var recipientVarsStr = fields['recipient-variables'];
    var toList = fields.to || [];
    var tags = fields['o:tag'] || [];
    var emailId = fields['v:email-id'] || '';
    var domain = req.params.domain || config.mailgunDomain;

    // Ensure toList is an array
    if (!Array.isArray(toList)) toList = [toList];
    if (!Array.isArray(tags)) tags = [tags];

    if (!from || !subject || toList.length === 0) {
      return res.status(400).json({ message: 'Missing required fields: from, subject, to' });
    }

    if (toList.length > config.maxRecipients) {
      return res.status(413).json({ message: 'Too many recipients in one request' });
    }

    try {
      from = sanitizeHeaderValue(from, 'from');
      subject = sanitizeHeaderValue(subject, 'subject');
      emailId = emailId ? sanitizeHeaderValue(emailId, 'v:email-id') : '';
      toList = toList.map(function(recipient) {
        return sanitizeHeaderValue(recipient, 'to');
      });
    } catch (err) {
      return res.status(err.status || 400).json({ message: err.message });
    }

    // Parse recipient variables
    var recipientVars = {};
    if (recipientVarsStr) {
      try {
        recipientVars = JSON.parse(recipientVarsStr);
      } catch (_e) {
        return res.status(400).json({ message: 'Invalid recipient-variables JSON' });
      }
    }

    // Generate batch message ID
    var batchId = crypto.randomUUID() + '@' + domain;
    var batchMessageId = '<' + batchId + '>';

    // Store batch in message_map
    insertMessageMap.run(batchMessageId, emailId, JSON.stringify(tags));

    // Extract headers from h:* fields
    var customHeaders = {};
    var customHeaderCount = 0;
    var fieldKeys = Object.keys(fields);
    try {
      for (var i = 0; i < fieldKeys.length; i++) {
        var key = fieldKeys[i];
        if (key.startsWith('h:') && key !== 'h:Reply-To' && key !== 'h:Sender' && key !== 'h:List-Unsubscribe' && key !== 'h:List-Unsubscribe-Post') {
          customHeaderCount++;
          if (customHeaderCount > config.maxCustomHeaders) {
            return res.status(413).json({ message: 'Too many custom headers' });
          }
          var headerName = sanitizeHeaderName(key.slice(2));
          customHeaders[headerName] = sanitizeHeaderValue(fields[key], key);
        }
      }
    } catch (err) {
      return res.status(err.status || 400).json({ message: err.message });
    }

    // Always add X-Ghost-Email-Id for fallback correlation
    if (emailId) {
      customHeaders['X-Ghost-Email-Id'] = emailId;
    }

    var replyTo = fields['h:Reply-To'] || '';
    var sender = fields['h:Sender'] || '';
    try {
      replyTo = replyTo ? sanitizeHeaderValue(replyTo, 'h:Reply-To') : '';
      sender = sender ? sanitizeHeaderValue(sender, 'h:Sender') : '';
    } catch (err) {
      return res.status(err.status || 400).json({ message: err.message });
    }

    // Send to each recipient with concurrency limiting
    var succeeded = 0;
    var failed = 0;
    var errors = [];

    var promises = toList.map(function(recipient) {
      return semaphore.acquire().then(function() {
        return Promise.resolve().then(function() {
          var vars = recipientVars[recipient] || {};

          // Substitute template variables
          var recipientHtml = substituteVars(html, vars);
          var recipientText = substituteVars(text, vars);

          // Process List-Unsubscribe header
          var listUnsubscribe = fields['h:List-Unsubscribe'] || '';
          if (listUnsubscribe) {
            listUnsubscribe = substituteVars(listUnsubscribe, vars);
            // Strip Mailgun-specific <%tag_unsubscribe_email%> placeholder
            listUnsubscribe = listUnsubscribe.replace(/,?\s*<%tag_unsubscribe_email%>/g, '');
            // Clean up trailing/leading commas and whitespace
            listUnsubscribe = listUnsubscribe.replace(/^,\s*/, '').replace(/,\s*$/, '').trim();
            listUnsubscribe = sanitizeHeaderValue(listUnsubscribe, 'h:List-Unsubscribe');
          }

          var listUnsubscribePost = fields['h:List-Unsubscribe-Post'] || '';
          if (listUnsubscribePost) {
            listUnsubscribePost = substituteVars(listUnsubscribePost, vars);
            listUnsubscribePost = sanitizeHeaderValue(listUnsubscribePost, 'h:List-Unsubscribe-Post');
          }

          // Build raw MIME message
          var rawMessage = buildRawMime({
            from: from,
            to: recipient,
            subject: subject,
            html: recipientHtml,
            text: recipientText,
            replyTo: replyTo,
            sender: sender,
            messageId: batchMessageId,
            listUnsubscribe: listUnsubscribe || undefined,
            listUnsubscribePost: listUnsubscribePost || undefined,
            customHeaders: customHeaders
          });

          return sendRawEmail(rawMessage, config.sesConfigurationSet).then(function(result) {
            // Store SES message ID -> batch mapping
            insertRecipientEmail.run(
              result.messageId,
              batchMessageId,
              recipient,
              emailId,
              JSON.stringify(tags)
            );
            succeeded++;
            if (config.logLevel === 'debug') {
              console.log('Sent to ' + recipient + ' (SES ID: ' + result.messageId + ')');
            }
          });
        }).catch(function(err) {
          var errorMessage = err && err.message ? err.message : String(err);
          failed++;
          errors.push({ recipient: recipient, error: errorMessage });
          console.error('Failed to send to ' + recipient + ': ' + errorMessage);
        }).finally(function() {
          semaphore.release();
        });
      });
    });

    return Promise.all(promises).then(function() {
      if (succeeded === 0 && failed > 0) {
        console.error('All ' + failed + ' recipients failed for batch ' + batchId);
        return res.status(500).json({
          message: 'Failed to send to all recipients',
          errors: errors
        });
      }

      if (failed > 0) {
        console.warn('Partial failure: ' + succeeded + ' succeeded, ' + failed + ' failed for batch ' + batchId);
      } else {
        console.log('Sent batch ' + batchId + ' to ' + succeeded + ' recipients');
      }

      // Return Mailgun-compatible response
      res.json({
        id: batchMessageId,
        message: 'Queued. Thank you.'
      });
    });
  }).catch(function(err) {
    var status = err && err.status ? err.status : 500;
    var message = err && err.message ? err.message : 'Unknown error';
    console.error('Send email error:', message);

    if (status >= 500) {
      return res.status(status).json({ message: 'Internal server error: ' + message });
    }

    return res.status(status).json({ message: message });
  });
}

module.exports = handleSendEmail;
