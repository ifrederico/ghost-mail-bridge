// SES event → Mailgun event normalization
// Pure function: no DB access, no side effects

var EVENT_MAP = {
  Delivery: { event: 'delivered', severity: null, code: 250, message: 'OK' },
  Open: { event: 'opened', severity: null, code: null, message: null },
  Click: { event: 'clicked', severity: null, code: null, message: null },
  Complaint: { event: 'complained', severity: null, code: null, message: null },
  Reject: { event: 'failed', severity: 'permanent', code: 607, message: 'Not delivering to previously bounced address' }
};

// Types we intentionally skip — no Mailgun equivalent
var SKIP_TYPES = { Send: true, DeliveryDelay: true };

function getRecipients(sesEvent) {
  var eventType = sesEvent.eventType;

  if (eventType === 'Delivery') {
    return sesEvent.delivery.recipients || [];
  }
  if (eventType === 'Bounce') {
    return (sesEvent.bounce.bouncedRecipients || []).map(function(r) { return r.emailAddress; });
  }
  if (eventType === 'Complaint') {
    return (sesEvent.complaint.complainedRecipients || []).map(function(r) { return r.emailAddress; });
  }
  // Open, Click, Reject — use mail.destination
  return (sesEvent.mail && sesEvent.mail.destination) || [];
}

function getTimestamp(sesEvent) {
  var eventType = sesEvent.eventType;
  var iso = null;

  if (eventType === 'Delivery' && sesEvent.delivery) {
    iso = sesEvent.delivery.timestamp;
  } else if (eventType === 'Bounce' && sesEvent.bounce) {
    iso = sesEvent.bounce.timestamp;
  } else if (eventType === 'Complaint' && sesEvent.complaint) {
    iso = sesEvent.complaint.timestamp || sesEvent.complaint.arrivalDate;
  } else if (eventType === 'Open' && sesEvent.open) {
    iso = sesEvent.open.timestamp;
  } else if (eventType === 'Click' && sesEvent.click) {
    iso = sesEvent.click.timestamp;
  }

  // Fallback to mail.timestamp
  if (!iso && sesEvent.mail) {
    iso = sesEvent.mail.timestamp;
  }

  if (iso) {
    var parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) {
      return parsed / 1000;
    }
  }

  return Date.now() / 1000;
}

function extractHeader(headers, name) {
  if (!headers || !Array.isArray(headers)) return null;
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].name === name) return headers[i].value;
  }
  return null;
}

function stripAngleBrackets(str) {
  if (!str) return str;
  return str.replace(/^</, '').replace(/>$/, '');
}

function mapSesEvent(sesEvent) {
  if (!sesEvent || !sesEvent.eventType) return [];

  var eventType = sesEvent.eventType;

  // Skip types with no Mailgun equivalent
  if (SKIP_TYPES[eventType]) return [];

  // Handle Bounce specially — severity depends on bounce type
  var mapping;
  if (eventType === 'Bounce') {
    var bounceType = sesEvent.bounce && sesEvent.bounce.bounceType;
    if (bounceType === 'Permanent') {
      mapping = { event: 'failed', severity: 'permanent', code: 607, message: 'Not delivering to previously bounced address' };
    } else {
      mapping = { event: 'failed', severity: 'temporary', code: 450, message: 'Temporary bounce' };
    }
  } else {
    mapping = EVENT_MAP[eventType];
  }

  if (!mapping) return [];

  var recipients = getRecipients(sesEvent);
  var timestamp = getTimestamp(sesEvent);
  var sesMessageId = sesEvent.mail && sesEvent.mail.messageId || null;

  // Extract headers for correlation fallback
  var headers = sesEvent.mail && sesEvent.mail.headers || [];
  var rawMessageId = extractHeader(headers, 'Message-ID');
  var batchMessageId = stripAngleBrackets(rawMessageId);
  var ghostEmailId = extractHeader(headers, 'X-Ghost-Email-Id');

  // Determine suppression
  var isSuppression = false;
  var suppressionType = null;
  var suppressionReason = null;

  if (eventType === 'Bounce' && sesEvent.bounce && sesEvent.bounce.bounceType === 'Permanent') {
    isSuppression = true;
    suppressionType = 'bounces';
    suppressionReason = 'Permanent bounce';
  } else if (eventType === 'Complaint') {
    isSuppression = true;
    suppressionType = 'complaints';
    suppressionReason = 'Spam complaint';
  } else if (eventType === 'Reject') {
    isSuppression = true;
    suppressionType = 'bounces';
    suppressionReason = 'Rejected by SES';
  }

  // Enhanced status code for bounces
  var enhancedCode = '';
  if (eventType === 'Bounce' && sesEvent.bounce && sesEvent.bounce.bouncedRecipients && sesEvent.bounce.bouncedRecipients.length > 0) {
    enhancedCode = sesEvent.bounce.bouncedRecipients[0].diagnosticCode || '';
  }

  return recipients.map(function(recipient) {
    return {
      event_type: mapping.event,
      severity: mapping.severity,
      recipient: recipient,
      timestamp: timestamp,
      ses_message_id: sesMessageId,
      ghost_email_id: ghostEmailId,
      batch_message_id: batchMessageId,
      delivery_status_code: mapping.code,
      delivery_status_message: mapping.message,
      delivery_status_enhanced: enhancedCode,
      is_suppression: isSuppression,
      suppression_type: suppressionType,
      suppression_reason: suppressionReason
    };
  });
}

module.exports = mapSesEvent;
