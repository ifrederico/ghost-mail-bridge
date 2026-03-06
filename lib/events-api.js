var { query } = require('./db');

var DEFAULT_LIMIT = 300;
var MAX_LIMIT = 1000;

function buildEventsPageUrl(req, domain, pageToken) {
  var proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  var url = new URL(proto + '://' + req.headers.host + '/v3/' + domain + '/events');
  var passthroughKeys = ['event', 'tags', 'begin', 'end', 'limit'];

  for (var i = 0; i < passthroughKeys.length; i += 1) {
    var key = passthroughKeys[i];
    if (req.query[key] !== undefined) {
      var value = req.query[key];
      if (Array.isArray(value)) {
        url.searchParams.delete(key);
        for (var j = 0; j < value.length; j += 1) {
          if (value[j] !== undefined && value[j] !== null) {
            url.searchParams.append(key, String(value[j]));
          }
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  if (pageToken) {
    url.searchParams.set('page', pageToken);
  } else {
    url.searchParams.delete('page');
  }

  return url.toString();
}

function normalizeFilterToArray(value, separator) {
  if (value === undefined || value === null) return [];

  var parts = [];

  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i += 1) {
      if (value[i] === undefined || value[i] === null) continue;
      if (separator && typeof value[i] === 'string') {
        parts = parts.concat(value[i].split(separator));
      } else {
        parts.push(String(value[i]));
      }
    }
  } else if (typeof value === 'string' && separator) {
    parts = value.split(separator);
  } else {
    parts = [String(value)];
  }

  return parts.map(function(valuePart) { return valuePart.trim(); }).filter(Boolean);
}

function parseLimit(value) {
  var parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

async function handleGetEvents(req, res) {
  var domain = req.params.domain;
  var pageToken = req.query.page || req.params.pageToken || null;
  var eventFilter = req.query.event;
  var tagsFilter = req.query.tags;
  var begin = parseFloat(req.query.begin) || 0;
  var end = parseFloat(req.query.end) || 9999999999;
  var limit = parseLimit(req.query.limit);
  var eventTypes = normalizeFilterToArray(eventFilter, ' OR ');
  var tags = normalizeFilterToArray(tagsFilter, ' AND ');
  var cursorTimestamp = null;
  var cursorId = null;

  if (pageToken) {
    try {
      var decoded = JSON.parse(Buffer.from(pageToken, 'base64').toString('utf8'));
      cursorTimestamp = decoded.t;
      cursorId = decoded.id;
    } catch (_err) {
      return res.status(400).json({ message: 'Invalid page token' });
    }
  }

  var conditions = [];
  var params = [];

  if (eventTypes.length > 0) {
    conditions.push('event_type IN (' + eventTypes.map(function() { return '?'; }).join(',') + ')');
    params = params.concat(eventTypes);
  }

  conditions.push('timestamp >= ?');
  params.push(begin);
  conditions.push('timestamp <= ?');
  params.push(end);

  for (var t = 0; t < tags.length; t += 1) {
    conditions.push('tags_json LIKE ?');
    params.push('%"' + tags[t] + '"%');
  }

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

  var rows = await query(sql, params);

  var items = rows.map(function(row) {
    var headers = {};
    if (row.message_id) {
      headers['message-id'] = row.message_id;
    }

    var item = {
      id: row.id,
      event: row.event_type,
      timestamp: row.timestamp,
      recipient: row.recipient,
      message: {
        headers: headers
      }
    };

    if (row.severity) {
      item.severity = row.severity;
    }

    if (row.delivery_status_code !== null && row.delivery_status_code !== undefined) {
      item['delivery-status'] = {
        code: row.delivery_status_code,
        message: row.delivery_status_message || '',
        description: '',
        'enhanced-code': row.delivery_status_enhanced || ''
      };
    }

    return item;
  });

  var nextCursor = null;
  if (rows.length > 0) {
    var lastRow = rows[rows.length - 1];
    nextCursor = Buffer.from(JSON.stringify({
      t: lastRow.timestamp,
      id: lastRow.id
    })).toString('base64');
  }

  res.json({
    items: items,
    paging: {
      next: buildEventsPageUrl(req, domain, nextCursor || pageToken),
      previous: buildEventsPageUrl(req, domain, pageToken),
      first: buildEventsPageUrl(req, domain, null),
      last: buildEventsPageUrl(req, domain, nextCursor || pageToken)
    }
  });
}

module.exports = handleGetEvents;
