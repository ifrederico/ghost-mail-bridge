## Queue-First Scaling Plan

  ### Summary

  Move the bridge from inline-send + SQLite to a queue-first architecture that can support much larger Ghost
  newsletter sends without changing Ghost itself. This is moderately invasive, not a rewrite: keep the
  current Mailgun-compatible API and dashboard, but split runtime into API + worker, store state in a
  separate MySQL service, and add a dedicated outbound SQS send queue. The new production mode is MySQL +
  SQS only; no SQLite compatibility mode. Existing SQLite data will not be migrated; keep the old file as
  backup/reference only.

  ### Implementation Changes

  - Keep Ghost integration unchanged:
      - POST /v3/:domain/messages stays the entrypoint Ghost uses.
      - GET /v3/:domain/events and dashboard routes stay in place.
      - The response to Ghost remains immediate and Mailgun-compatible (Queued. Thank you.), but sending
        happens asynchronously after enqueue.
  - Split runtime into two roles using the same codebase/image:
      - api role: validate request, persist batch/job, enqueue outbound send job, return immediately.
      - worker role: consume outbound send jobs, send recipients via SES, persist per-recipient mappings/
        errors, continue existing SES-event processing.
  - Add a dedicated outbound SQS queue path:
      - New queue for newsletter send jobs.
      - New DLQ for failed send jobs.
      - Existing SES event SQS pipeline stays separate.
  - Replace SQLite persistence with MySQL using mysql2/promise and direct SQL:
      - Add a MySQL connection/pool module.
      - Replace SQLite-specific SQL (strftime, datetime, INSERT OR IGNORE, WAL pragmas, file-path DB logic)
        with MySQL-compatible queries.
      - Rework dashboard aggregation queries for MySQL date/time functions.
  - Introduce explicit batch/job state in MySQL:
      - Batch table for inbound Ghost requests.
      - Recipient/message mapping table for SES correlation.
      - Event table for Mailgun-compatible history.
      - Suppressions table.
      - Send job table or equivalent persisted queue-tracking table for worker progress (queued, processing,
        partial, failed, completed).
  - Update dashboard behavior:
      - Add worker/send-queue status visibility.
      - Show queued/processing/failed batch counts.
      - Keep the existing “Ghost bulk email target” guidance.
  - Update deployment/config:
      - Add a separate MySQL service to the example compose setup.
      - Add separate api and worker service definitions using the same app image.
      - Add env/config for MySQL connection and outbound send queue URLs.
      - Keep the service name ghost-mail-bridge.
  - Update docs/steps:
      - Document the new outbound send queue + DLQ.
      - Document separate MySQL service for the bridge.
      - Keep Ghost setup unchanged from the user’s perspective except for standard env/config.
      - Mark the current SQLite file as legacy backup only during migration.

  ### Interfaces and Config

  - Public/Ghost-facing API stays the same:
      - /v3/:domain/messages
      - /v3/:domain/events
      - /ghost/mail
  - New runtime/deployment interfaces:
      - DATABASE_URL for MySQL connection.
      - NEWSLETTER_SEND_QUEUE_URL and NEWSLETTER_SEND_DLQ_URL (or equivalent explicit queue env names).
      - Worker role selector env/command, or separate API/worker commands if cleaner.
  - AWS/IAM additions:
      - sqs:SendMessage for outbound send queue.
      - Existing event-queue permissions remain.
      - SES identity + configuration set permissions remain required.

  ### Test Plan

  - Unit:
      - enqueue path validates and persists batch/job without sending inline
      - worker consumes one job and sends expected recipients
      - idempotent handling for duplicate/retried jobs
      - MySQL query layer for aggregates, suppression lookups, and event pagination
  - Integration:
      - Ghost-compatible send request returns quickly while job remains queued
      - worker later creates recipient mappings and SES send results
  - Migration/cutover:
      - keep old SQLite file untouched as backup
      - large newsletter send no longer blocks Ghost on inline SES work
      - public/dashboard behavior stays unchanged for end users
      - fake-cookie dashboard auth still returns 401
      - Ghost still works without any Ghost code changes
  - Production target is now the scalable path only: MySQL + SQS, no SQLite fallback mode.
  - Separate MySQL service is preferred over sharing Ghost’s DB.
  - Outbound newsletter sending uses a dedicated SQS queue.