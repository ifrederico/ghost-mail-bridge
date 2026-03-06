var mysql = require('mysql2/promise');
var config = require('./config');

var pool;
var cleanupTimer;

function parseDatabaseUrl(databaseUrl) {
  var parsed = new URL(databaseUrl);
  var database = parsed.pathname.replace(/^\/+/, '');

  if (!database) {
    throw new Error('DATABASE_URL must include a database name');
  }

  return {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : 3306,
    user: decodeURIComponent(parsed.username || ''),
    password: decodeURIComponent(parsed.password || ''),
    database: database
  };
}

function getPool() {
  if (!pool) {
    var connection = parseDatabaseUrl(config.databaseUrl);

    pool = mysql.createPool({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password,
      database: connection.database,
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: config.dbConnectionLimit,
      connectTimeout: config.dbConnectTimeoutMs,
      timezone: 'Z'
    });
  }

  return pool;
}

async function query(sql, params) {
  var conn = getPool();
  var result = await conn.query(sql, params || []);
  return result[0];
}

async function execute(sql, params) {
  var conn = getPool();
  var result = await conn.execute(sql, params || []);
  return result[0];
}

async function queryOne(sql, params) {
  var rows = await query(sql, params);
  return rows[0] || null;
}

async function withTransaction(fn) {
  var connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    var result = await fn(connection);
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch (_rollbackErr) {
      // Best effort rollback.
    }
    throw err;
  } finally {
    connection.release();
  }
}

function unwrapCount(row, key) {
  return Number(row && row[key]) || 0;
}

async function ensureSchema() {
  await query(
    'CREATE TABLE IF NOT EXISTS batches (' +
      'id CHAR(36) PRIMARY KEY,' +
      'batch_message_id VARCHAR(255) NOT NULL UNIQUE,' +
      'domain VARCHAR(255) NOT NULL,' +
      'ghost_email_id VARCHAR(255) DEFAULT \'\',' +
      'status VARCHAR(32) NOT NULL,' +
      'from_header TEXT NOT NULL,' +
      'subject TEXT NOT NULL,' +
      'html_body LONGTEXT,' +
      'text_body LONGTEXT,' +
      'reply_to TEXT,' +
      'sender TEXT,' +
      'list_unsubscribe_template TEXT,' +
      'list_unsubscribe_post_template TEXT,' +
      'custom_headers_json LONGTEXT NOT NULL,' +
      'recipient_variables_json LONGTEXT NOT NULL,' +
      'tags_json LONGTEXT NOT NULL,' +
      'recipients_json LONGTEXT NOT NULL,' +
      'total_recipients INT NOT NULL,' +
      'queued_recipients INT NOT NULL DEFAULT 0,' +
      'processing_recipients INT NOT NULL DEFAULT 0,' +
      'sent_recipients INT NOT NULL DEFAULT 0,' +
      'failed_recipients INT NOT NULL DEFAULT 0,' +
      'last_error TEXT,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'queued_at DATETIME NULL,' +
      'started_at DATETIME NULL,' +
      'completed_at DATETIME NULL,' +
      'KEY idx_batches_status (status),' +
      'KEY idx_batches_created_at (created_at)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );

  await query(
    'CREATE TABLE IF NOT EXISTS send_jobs (' +
      'id CHAR(36) PRIMARY KEY,' +
      'batch_id CHAR(36) NOT NULL UNIQUE,' +
      'status VARCHAR(32) NOT NULL,' +
      'total_recipients INT NOT NULL,' +
      'sent_recipients INT NOT NULL DEFAULT 0,' +
      'failed_recipients INT NOT NULL DEFAULT 0,' +
      'attempt_count INT NOT NULL DEFAULT 0,' +
      'worker_instance_id VARCHAR(255) DEFAULT NULL,' +
      'last_error TEXT,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'queued_at DATETIME NULL,' +
      'started_at DATETIME NULL,' +
      'completed_at DATETIME NULL,' +
      'CONSTRAINT fk_send_jobs_batch FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,' +
      'KEY idx_send_jobs_status (status),' +
      'KEY idx_send_jobs_updated_at (updated_at)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );

  await query(
    'CREATE TABLE IF NOT EXISTS recipient_emails (' +
      'ses_message_id VARCHAR(255) PRIMARY KEY,' +
      'batch_message_id VARCHAR(255) NOT NULL,' +
      'recipient VARCHAR(320) NOT NULL,' +
      'ghost_email_id VARCHAR(255) DEFAULT \'\',' +
      'tags_json LONGTEXT NOT NULL,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'UNIQUE KEY uniq_batch_recipient (batch_message_id, recipient),' +
      'KEY idx_recipient_emails_batch (batch_message_id),' +
      'KEY idx_recipient_emails_recipient (recipient),' +
      'KEY idx_recipient_emails_created_at (created_at)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );

  await query(
    'CREATE TABLE IF NOT EXISTS events (' +
      'id VARCHAR(64) PRIMARY KEY,' +
      'event_type VARCHAR(32) NOT NULL,' +
      'severity VARCHAR(32) DEFAULT NULL,' +
      'recipient VARCHAR(320) NOT NULL,' +
      'timestamp BIGINT NOT NULL,' +
      'message_id VARCHAR(255) DEFAULT NULL,' +
      'email_id VARCHAR(255) DEFAULT NULL,' +
      'delivery_status_code INT DEFAULT NULL,' +
      'delivery_status_message TEXT,' +
      'delivery_status_enhanced TEXT,' +
      'tags_json LONGTEXT NOT NULL,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'KEY idx_events_timestamp (timestamp),' +
      'KEY idx_events_type (event_type),' +
      'KEY idx_events_message (message_id),' +
      'KEY idx_events_created_at (created_at)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );

  await query(
    'CREATE TABLE IF NOT EXISTS suppressions (' +
      'id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,' +
      'email VARCHAR(320) NOT NULL,' +
      'type VARCHAR(32) NOT NULL,' +
      'reason TEXT,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'UNIQUE KEY uniq_suppressions_email_type (email, type),' +
      'KEY idx_suppressions_created_at (created_at)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );

  await query(
    'CREATE TABLE IF NOT EXISTS runtime_heartbeats (' +
      'instance_id VARCHAR(255) PRIMARY KEY,' +
      'role VARCHAR(32) NOT NULL,' +
      'state_json LONGTEXT NOT NULL,' +
      'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'KEY idx_runtime_role_updated_at (role, updated_at)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );
}

async function initDb() {
  await ensureSchema();
  return getPool();
}

async function getTableCounts() {
  var counts = await Promise.all([
    queryOne('SELECT COUNT(*) AS c FROM batches'),
    queryOne('SELECT COUNT(*) AS c FROM send_jobs'),
    queryOne('SELECT COUNT(*) AS c FROM recipient_emails'),
    queryOne('SELECT COUNT(*) AS c FROM events'),
    queryOne('SELECT COUNT(*) AS c FROM suppressions')
  ]);

  return {
    batches: unwrapCount(counts[0], 'c'),
    send_jobs: unwrapCount(counts[1], 'c'),
    recipient_emails: unwrapCount(counts[2], 'c'),
    events: unwrapCount(counts[3], 'c'),
    suppressions: unwrapCount(counts[4], 'c')
  };
}

async function createBatchWithJob(input) {
  return withTransaction(async function(connection) {
    await connection.execute(
      'INSERT INTO batches (' +
        'id, batch_message_id, domain, ghost_email_id, status, from_header, subject, html_body, text_body,' +
        'reply_to, sender, list_unsubscribe_template, list_unsubscribe_post_template,' +
        'custom_headers_json, recipient_variables_json, tags_json, recipients_json, total_recipients,' +
        'queued_recipients, processing_recipients, sent_recipients, failed_recipients, queued_at' +
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
      [
        input.batchId,
        input.batchMessageId,
        input.domain,
        input.ghostEmailId || '',
        'queued',
        input.from,
        input.subject,
        input.html || '',
        input.text || '',
        input.replyTo || '',
        input.sender || '',
        input.listUnsubscribe || '',
        input.listUnsubscribePost || '',
        input.customHeadersJson,
        input.recipientVariablesJson,
        input.tagsJson,
        input.recipientsJson,
        input.totalRecipients,
        input.totalRecipients,
        0,
        0,
        0
      ]
    );

    await connection.execute(
      'INSERT INTO send_jobs (' +
        'id, batch_id, status, total_recipients, sent_recipients, failed_recipients, queued_at' +
      ') VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
      [
        input.jobId,
        input.batchId,
        'queued',
        input.totalRecipients,
        0,
        0
      ]
    );

    return {
      batchId: input.batchId,
      jobId: input.jobId
    };
  });
}

async function getSendJobWithBatch(jobId) {
  return queryOne(
    'SELECT ' +
      'j.id AS job_id, j.status AS job_status, j.total_recipients AS job_total_recipients,' +
      'j.sent_recipients AS job_sent_recipients, j.failed_recipients AS job_failed_recipients,' +
      'j.attempt_count, j.worker_instance_id, j.last_error AS job_last_error,' +
      'j.queued_at AS job_queued_at, j.started_at AS job_started_at, j.completed_at AS job_completed_at,' +
      'b.id AS batch_id, b.batch_message_id, b.domain, b.ghost_email_id, b.status AS batch_status,' +
      'b.from_header, b.subject, b.html_body, b.text_body, b.reply_to, b.sender,' +
      'b.list_unsubscribe_template, b.list_unsubscribe_post_template, b.custom_headers_json,' +
      'b.recipient_variables_json, b.tags_json, b.recipients_json, b.total_recipients,' +
      'b.queued_recipients, b.processing_recipients, b.sent_recipients, b.failed_recipients,' +
      'b.last_error AS batch_last_error, b.created_at, b.updated_at, b.started_at, b.completed_at ' +
    'FROM send_jobs j INNER JOIN batches b ON b.id = j.batch_id WHERE j.id = ?',
    [jobId]
  );
}

async function claimSendJob(jobId, workerInstanceId) {
  return withTransaction(async function(connection) {
    var rows = await connection.query(
      'SELECT id, batch_id, status FROM send_jobs WHERE id = ? FOR UPDATE',
      [jobId]
    );
    var job = rows[0][0];

    if (!job) {
      return { claimed: false, reason: 'missing' };
    }

    if (job.status === 'processing') {
      return { claimed: false, reason: 'processing' };
    }

    if (job.status === 'completed') {
      return { claimed: false, reason: 'completed' };
    }

    await connection.execute(
      'UPDATE send_jobs SET status = ?, worker_instance_id = ?, attempt_count = attempt_count + 1,' +
      'started_at = COALESCE(started_at, UTC_TIMESTAMP()), completed_at = NULL, last_error = NULL WHERE id = ?',
      ['processing', workerInstanceId, jobId]
    );

    await connection.execute(
      'UPDATE batches SET status = ?, queued_recipients = 0,' +
      'processing_recipients = GREATEST(total_recipients - sent_recipients - failed_recipients, 0),' +
      'started_at = COALESCE(started_at, UTC_TIMESTAMP()), completed_at = NULL, last_error = NULL WHERE id = ?',
      ['processing', job.batch_id]
    );

    return { claimed: true };
  });
}

async function setSendJobResult(jobId, batchId, result) {
  return withTransaction(async function(connection) {
    await connection.execute(
      'UPDATE send_jobs SET status = ?, sent_recipients = ?, failed_recipients = ?,' +
      'completed_at = UTC_TIMESTAMP(), last_error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [
        result.status,
        result.sentRecipients,
        result.failedRecipients,
        result.lastError || null,
        jobId
      ]
    );

    await connection.execute(
      'UPDATE batches SET status = ?, queued_recipients = ?, processing_recipients = ?, sent_recipients = ?, failed_recipients = ?,' +
      'completed_at = UTC_TIMESTAMP(), last_error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [
        result.status,
        result.queuedRecipients || 0,
        0,
        result.sentRecipients,
        result.failedRecipients,
        result.lastError || null,
        batchId
      ]
    );
  });
}

async function setSendJobRetryState(jobId, batchId, result) {
  return withTransaction(async function(connection) {
    await connection.execute(
      'UPDATE send_jobs SET status = ?, sent_recipients = ?, failed_recipients = ?, completed_at = NULL, last_error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [
        result.status,
        result.sentRecipients,
        result.failedRecipients,
        result.lastError || null,
        jobId
      ]
    );

    await connection.execute(
      'UPDATE batches SET status = ?, queued_recipients = ?, processing_recipients = ?, sent_recipients = ?, failed_recipients = ?,' +
      'completed_at = NULL, last_error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [
        result.status,
        result.queuedRecipients,
        0,
        result.sentRecipients,
        result.failedRecipients,
        result.lastError || null,
        batchId
      ]
    );
  });
}

async function recordRecipientEmail(record) {
  await execute(
    'INSERT INTO recipient_emails (ses_message_id, batch_message_id, recipient, ghost_email_id, tags_json) ' +
    'VALUES (?, ?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE ghost_email_id = VALUES(ghost_email_id), tags_json = VALUES(tags_json)',
    [
      record.sesMessageId,
      record.batchMessageId,
      record.recipient,
      record.ghostEmailId || '',
      record.tagsJson || '[]'
    ]
  );
}

async function getExistingRecipientsForBatch(batchMessageId) {
  var rows = await query(
    'SELECT recipient FROM recipient_emails WHERE batch_message_id = ?',
    [batchMessageId]
  );

  return rows.map(function(row) { return row.recipient; });
}

async function lookupRecipientEmail(sesMessageId) {
  return queryOne(
    'SELECT * FROM recipient_emails WHERE ses_message_id = ?',
    [sesMessageId]
  );
}

async function insertEvent(record) {
  await execute(
    'INSERT INTO events (' +
      'id, event_type, severity, recipient, timestamp, message_id, email_id, delivery_status_code,' +
      'delivery_status_message, delivery_status_enhanced, tags_json' +
    ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE ' +
      'event_type = VALUES(event_type),' +
      'severity = VALUES(severity),' +
      'delivery_status_code = VALUES(delivery_status_code),' +
      'delivery_status_message = VALUES(delivery_status_message),' +
      'delivery_status_enhanced = VALUES(delivery_status_enhanced)',
    [
      record.id,
      record.eventType,
      record.severity || null,
      record.recipient,
      record.timestamp,
      record.messageId || null,
      record.emailId || null,
      record.deliveryStatusCode === undefined ? null : record.deliveryStatusCode,
      record.deliveryStatusMessage || '',
      record.deliveryStatusEnhanced || '',
      record.tagsJson || '[]'
    ]
  );
}

async function upsertSuppression(email, type, reason) {
  await execute(
    'INSERT INTO suppressions (email, type, reason) VALUES (?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE reason = VALUES(reason), updated_at = UTC_TIMESTAMP()',
    [email, type, reason || null]
  );
}

async function deleteSuppression(email, type) {
  await execute(
    'DELETE FROM suppressions WHERE email = ? AND type = ?',
    [email, type]
  );
}

async function updateRuntimeHeartbeat(instanceId, role, state) {
  await execute(
    'INSERT INTO runtime_heartbeats (instance_id, role, state_json) VALUES (?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE role = VALUES(role), state_json = VALUES(state_json), updated_at = UTC_TIMESTAMP()',
    [instanceId, role, JSON.stringify(state || {})]
  );
}

async function listRuntimeHeartbeats(role, maxAgeSeconds) {
  var rows = await query(
    'SELECT instance_id, role, state_json, created_at, updated_at FROM runtime_heartbeats ' +
    'WHERE role = ? AND updated_at >= FROM_UNIXTIME(UNIX_TIMESTAMP(UTC_TIMESTAMP()) - ?) ORDER BY updated_at DESC',
    [role, maxAgeSeconds]
  );

  return rows.map(function(row) {
    var state = {};
    try {
      state = JSON.parse(row.state_json || '{}');
    } catch (_err) {
      state = {};
    }

    return {
      instanceId: row.instance_id,
      role: row.role,
      state: state,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

async function cleanupExpiredData() {
  await query(
    'DELETE FROM batches WHERE created_at < FROM_UNIXTIME(UNIX_TIMESTAMP(UTC_TIMESTAMP()) - ?)',
    [config.batchRetentionDays * 86400]
  );

  await query(
    'DELETE FROM recipient_emails WHERE created_at < FROM_UNIXTIME(UNIX_TIMESTAMP(UTC_TIMESTAMP()) - ?)',
    [config.batchRetentionDays * 86400]
  );

  await query(
    'DELETE FROM events WHERE created_at < FROM_UNIXTIME(UNIX_TIMESTAMP(UTC_TIMESTAMP()) - ?)',
    [config.eventRetentionDays * 86400]
  );

  await query(
    'DELETE FROM runtime_heartbeats WHERE updated_at < FROM_UNIXTIME(UNIX_TIMESTAMP(UTC_TIMESTAMP()) - ?)',
    [7 * 86400]
  );

  if (config.suppressionRetentionDays > 0) {
    await query(
      'DELETE FROM suppressions WHERE created_at < FROM_UNIXTIME(UNIX_TIMESTAMP(UTC_TIMESTAMP()) - ?)',
      [config.suppressionRetentionDays * 86400]
    );
  }
}

function startCleanupTask() {
  if (cleanupTimer) return cleanupTimer;

  cleanupTimer = setInterval(function() {
    cleanupExpiredData().catch(function(err) {
      console.error('Cleanup error:', err && err.message ? err.message : String(err));
    });
  }, config.cleanupIntervalMs);

  return cleanupTimer;
}

function stopCleanupTask() {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

async function closeDb() {
  stopCleanupTask();

  if (!pool) return;

  var currentPool = pool;
  pool = null;
  await currentPool.end();
}

module.exports = {
  initDb: initDb,
  closeDb: closeDb,
  query: query,
  queryOne: queryOne,
  execute: execute,
  withTransaction: withTransaction,
  getTableCounts: getTableCounts,
  createBatchWithJob: createBatchWithJob,
  getSendJobWithBatch: getSendJobWithBatch,
  claimSendJob: claimSendJob,
  setSendJobResult: setSendJobResult,
  setSendJobRetryState: setSendJobRetryState,
  recordRecipientEmail: recordRecipientEmail,
  getExistingRecipientsForBatch: getExistingRecipientsForBatch,
  lookupRecipientEmail: lookupRecipientEmail,
  insertEvent: insertEvent,
  upsertSuppression: upsertSuppression,
  deleteSuppression: deleteSuppression,
  updateRuntimeHeartbeat: updateRuntimeHeartbeat,
  listRuntimeHeartbeats: listRuntimeHeartbeats,
  cleanupExpiredData: cleanupExpiredData,
  startCleanupTask: startCleanupTask,
  stopCleanupTask: stopCleanupTask
};
