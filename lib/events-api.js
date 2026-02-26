var { db } = require('./db');

function handleGetEvents(req, res) {
  var domain = req.params.domain;
  var pageToken = req.params.pageToken || null;

  // Parse query parameters
  var eventFilter = req.query.event;
  var tagsFilter = req.query.tags;
  var begin = parseFloat(req.query.begin) || 0;
  var end = parseFloat(req.query.end) || 9999999999;
  var limit = parseInt(req.query.limit, 10) || 300;

  // Parse event types: "delivered OR opened OR failed" → array
  var eventTypes = [];
  if (eventFilter) {
    eventTypes = eventFilter.split(' OR ').map(function(s) { return s.trim(); }).filter(Boolean);
  }

  // Parse tags: "bulk-email AND ghost-email" → array
  var tags = [];
  if (tagsFilter) {
    tags = tagsFilter.split(' AND ').map(function(s) { return s.trim(); }).filter(Boolean);
  }

  // Decode cursor from page token
  var cursorTimestamp = null;
  var cursorId = null;
  if (pageToken) {
    try {
      var decoded = JSON.parse(Buffer.from(pageToken, 'base64').toString('utf8'));
      cursorTimestamp = decoded.t;
      cursorId = decoded.id;
    } catch (e) {
      return res.status(400).json({ message: 'Invalid page token' });
    }
  }

  // Build dynamic SQL
  var conditions = [];
  var params = [];

  // Event type filter
  if (eventTypes.length > 0) {
    var placeholders = eventTypes.map(function() { return '?'; }).join(',');
    conditions.push('event_type IN (' + placeholders + ')');
    for (var i = 0; i < eventTypes.length; i++) {
      params.push(eventTypes[i]);
    }
  }

  // Time range
  conditions.push('timestamp >= ?');
  params.push(begin);
  conditions.push('timestamp <= ?');
  params.push(end);

  // Tag filters (LIKE match on JSON array)
  for (var t = 0; t < tags.length; t++) {
    conditions.push('tags LIKE ?');
    params.push('%"' + tags[t] + '"%');
  }

  // Cursor pagination (keyset)
  if (cursorTimestamp !== null && cursorId !== null) {
    conditions.push('(timestamp > ? OR (timestamp = ? AND id > ?))');
    params.push(cursorTimestamp, cursorTimestamp, cursorId);
  }

  var sql = 'SELECT * FROM events';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY timestamp ASC, id ASC LIMIT ?';
  params.push(limit);

  var stmt = db.prepare(sql);
  var rows = stmt.all.apply(stmt, params);

  // Format rows to Mailgun event objects
  var items = rows.map(function(row) {
    var item = {
      id: row.id,
      event: row.event_type,
      timestamp: row.timestamp,
      recipient: row.recipient,
      message: {
        headers: {
          'message-id': row.message_id || ''
        }
      },
      'user-variables': {
        'email-id': row.email_id || ''
      }
    };

    if (row.severity) {
      item.severity = row.severity;
    }

    if (row.delivery_status_code !== null) {
      item['delivery-status'] = {
        code: row.delivery_status_code,
        message: row.delivery_status_message || '',
        description: '',
        'enhanced-code': row.delivery_status_enhanced || ''
      };
    }

    return item;
  });

  // Build paging
  var paging = {
    next: '',
    previous: '',
    first: '',
    last: ''
  };

  if (rows.length === limit) {
    var lastRow = rows[rows.length - 1];
    var nextCursor = Buffer.from(JSON.stringify({
      t: lastRow.timestamp,
      id: lastRow.id
    })).toString('base64');

    var proto = req.headers['x-forwarded-proto'] || 'http';
    paging.next = proto + '://' + req.headers.host + '/v3/' + domain + '/events/' + nextCursor;
  }

  res.json({
    items: items,
    paging: paging
  });
}

module.exports = handleGetEvents;
