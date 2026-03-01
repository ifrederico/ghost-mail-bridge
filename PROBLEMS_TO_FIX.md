# Ghost SES Proxy - Problems To Fix Later

Date: 2026-03-01

## 1) Duplicate event counting from SQS redelivery
- Priority: High
- Status: Fixed in code
- Files: `lib/sqs-poller.js`, `lib/db.js`
- Problem:
  - SQS Standard is at-least-once delivery.
  - Current event storage uses a random UUID as `events.id`, so the same SES event can be inserted multiple times if SQS redelivers.
  - This can overcount opens/clicks/deliveries in Ghost analytics.
- Suggested fix:
  - Build a deterministic event key from SES payload fields (for example: SES message ID + event type + recipient + event timestamp + link/url for click if present).
  - Use that as the primary key or add a unique index and keep `INSERT OR IGNORE`.

## 2) Suppressions are auto-deleted after 90 days
- Priority: Medium-High
- Status: Fixed in code
- File: `lib/db.js`
- Problem:
  - Daily cleanup deletes rows from `suppressions` older than 90 days.
  - For deliverability safety, permanent bounces/complaints usually should not expire automatically.
- Suggested fix:
  - Do not clean `suppressions` by default, or make retention configurable via env var (for example `SUPPRESSION_RETENTION_DAYS` with `0` = never delete).

## 3) Unbounded `limit` on events endpoint
- Priority: Medium
- Status: Fixed in code
- File: `lib/events-api.js`
- Problem:
  - `limit` is taken from query without max cap.
  - A very large limit can cause heavy queries and large responses.
- Suggested fix:
  - Enforce a max cap (for example `1000`) and clamp invalid values.

## 4) Optional hardening: validate event timestamp parse
- Priority: Low
- Status: Fixed in code
- File: `lib/event-mapper.js`
- Problem:
  - `new Date(iso).getTime()` can become `NaN` for malformed timestamps.
  - Current code falls through to `NaN / 1000` if `iso` exists but is invalid.
- Suggested fix:
  - Validate parsed timestamp and fallback to current epoch seconds when invalid.

## Notes
- Current Ghost 6 pagination compatibility fixes appear correct and should remain:
  - Support `?page=` token.
  - Preserve query filters in paging URLs.
  - Return valid URL strings in paging fields.
