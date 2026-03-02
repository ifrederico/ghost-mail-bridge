# ghost-mail-bridge

Send Ghost newsletter emails through **AWS SES** instead of Mailgun. This bridge impersonates the Mailgun API so Ghost can keep its native bulk-email lane unchanged.

Originally based on `https://github.com/josephsellers/ghost-ses-proxy`, now independently maintained as `https://github.com/ifrederico/ghost-mail-bridge`.

## How it works

Ghost keeps two email lanes:
- Transactional lane (`mail__*`) -> SES SMTP
- Newsletter lane (`bulkEmail__mailgun__*`) -> this bridge -> SES API

```text
Sending:
  Ghost --POST /v3/:domain/messages--> ghost-mail-bridge --SES SendRawEmail--> AWS SES --> Recipients

Events (delivery, opens, clicks, bounces, complaints):
  AWS SES --> SNS Topic --> SQS Queue --> ghost-mail-bridge --> SQLite
  Ghost --GET /v3/:domain/events--> ghost-mail-bridge --> reads from SQLite
```

The bridge handles:
- Sending: parses Mailgun multipart form data, substitutes `%recipient.*%`, builds raw MIME, sends via SES
- Event tracking: polls SQS for SES events, maps them to Mailgun-compatible event objects
- Suppressions: stores bounce/complaint suppressions with Mailgun-compatible delete endpoint
- Authentication: validates Ghost Mailgun Basic auth against `PROXY_API_KEY`
- Input hardening: enforces multipart/request/header limits
- Admin dashboard: lightweight ops UI/API at `ADMIN_BASE_PATH` (default `/ghost/email`)

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/ifrederico/ghost-mail-bridge.git
cd ghost-mail-bridge
cp .env.example .env
# Edit .env
```

### 2. Run with Docker Compose

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

### 3. Verify service

```bash
curl http://localhost:3003/health
# {"status":"ok","tables":{"message_map":0,"recipient_emails":0,"events":0,"suppressions":0}}
```

## Mount the dashboard

The dashboard is available at `/ghost/email` by default.
If you want a different URL, set `ADMIN_BASE_PATH`.

Dashboard auth:
- Default: validates Ghost admin session cookies and redirects browser users to `/ghost/#/signin` when not logged in
- Session mode requires `GHOST_ADMIN_URL` (fixed Ghost base URL for session validation)
- If `GHOST_ADMIN_URL` is unset, dashboard routes return `503` (misconfigured)

Example Nginx mapping for `http://yourdomain.com/ghost/email/`:

```nginx
location /ghost/email/ {
  proxy_pass http://ghost-mail-bridge:3003/ghost/email/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Cookie $http_cookie;
}
```

## Configure Ghost

Ghost service environment example:

```yaml
services:
  ghost:
    environment:
      # Transactional lane: SES SMTP
      mail__transport: SMTP
      mail__from: '"Example Site" <noreply@example.com>'
      mail__options__host: email-smtp.us-east-1.amazonaws.com
      mail__options__port: 587
      mail__options__secure: "false"
      mail__options__auth__user: ${SES_SMTP_USERNAME}
      mail__options__auth__pass: ${SES_SMTP_PASSWORD}

      # Newsletter lane: Mailgun-compatible API -> bridge
      bulkEmail__mailgun__baseUrl: http://ghost-mail-bridge:3003/v3
      bulkEmail__mailgun__apiKey: ${PROXY_API_KEY}
      bulkEmail__mailgun__domain: ${MAILGUN_DOMAIN}
```

Keep Ghost architecture unchanged. This project unifies provider (SES), not Ghost lanes.

## Cutover validation checklist

- Sign-in magic link works
- Password reset works
- Staff invite/notification emails work
- Newsletter send works through bridge
- Delivery/open/click/bounce/complaint events appear in Ghost

After validation, remove legacy real-Mailgun runtime secrets. Keep `bulkEmail__mailgun__apiKey` + `bulkEmail__mailgun__domain` for compatibility.

## AWS setup guide

Create:
- Verified SES identity (domain)
- SES Configuration Set (for event publishing)
- SNS topic
- SQS queue (subscribed to SNS)
- SQS DLQ (recommended)

Set SQS policy so only your SNS topic can publish (`aws:SourceArn` and preferably `aws:SourceAccount`).

IAM permissions needed by bridge credentials:
- `ses:SendRawEmail`
- `sqs:ReceiveMessage`
- `sqs:DeleteMessage`
- `sqs:GetQueueAttributes`

## API reference

Mailgun-compatible endpoints used by Ghost:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/health` | service health and table counts |
| `POST` | `/v3/:domain/messages` | send bulk email |
| `GET` | `/v3/:domain/events` | fetch events |
| `GET` | `/v3/:domain/events/:pageToken` | fetch next event page |
| `DELETE` | `/v3/:domain/:type/:email` | delete suppression |

Admin/dashboard endpoints:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `${ADMIN_BASE_PATH}` | dashboard HTML |
| `GET` | `${ADMIN_BASE_PATH}/api/health` | dashboard health + poller status |
| `GET` | `${ADMIN_BASE_PATH}/api/summary` | 24h send/event summary |
| `GET` | `${ADMIN_BASE_PATH}/api/failures` | recent failed/complained events |

## Configuration reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_ACCESS_KEY_ID` | Yes | - | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | - | IAM secret key |
| `AWS_REGION` | No | `us-east-1` | AWS region for SES and SQS |
| `SQS_QUEUE_URL` | Yes | - | SQS queue URL for SES events |
| `SES_CONFIGURATION_SET` | No | `ghost-mail-bridge` | SES Configuration Set |
| `PROXY_API_KEY` | Yes | - | Ghost bulk-email API key |
| `MAILGUN_DOMAIN` | Yes | - | Ghost bulk-email domain value |
| `PORT` | No | `3003` | HTTP port |
| `LOG_LEVEL` | No | `info` | set `debug` for per-recipient send logs |
| `SEND_CONCURRENCY` | No | `10` | max parallel SES sends |
| `SES_SEND_MAX_RETRIES` | No | `3` | max retry count per recipient for transient SES errors |
| `SES_RETRY_BASE_MS` | No | `500` | base backoff in milliseconds for retries |
| `SES_RETRY_MAX_MS` | No | `10000` | max backoff cap in milliseconds for retries |
| `SUPPRESSION_RETENTION_DAYS` | No | `0` | suppression retention days (`0` = forever) |
| `MAX_REQUEST_BYTES` | No | `10485760` | max request size |
| `MAX_FORM_FIELDS` | No | `2000` | max multipart fields |
| `MAX_FIELD_SIZE_BYTES` | No | `2097152` | max multipart field size |
| `MAX_RECIPIENTS` | No | `50000` | max recipients per request |
| `MAX_CUSTOM_HEADERS` | No | `100` | max custom `h:*` headers |
| `ADMIN_BASE_PATH` | No | `/ghost/email` | dashboard path |
| `GHOST_ADMIN_URL` | Conditional | empty | required for dashboard auth; fixed Ghost base URL for session validation |
| `GHOST_ACCEPT_VERSION` | No | `v6.0` | Ghost Admin API version header |

## Event mapping

| SES Event | Mailgun Event | Notes |
|-----------|--------------|-------|
| Delivery | `delivered` | |
| Open | `opened` | |
| Click | `clicked` | |
| Bounce (Permanent) | `failed` (severity: permanent) | adds suppression |
| Bounce (Transient) | `failed` (severity: temporary) | |
| Complaint | `complained` | adds suppression |
| Reject | `failed` (severity: permanent) | adds suppression |
| Send, DeliveryDelay | skipped | no Mailgun equivalent |

## Storage

SQLite path: `/data/ses-proxy.db`

Tables:
- `message_map`
- `recipient_emails`
- `events`
- `suppressions`

Cleanup runs daily:
- send/event mapping older than 90 days is removed
- suppressions are retained forever unless `SUPPRESSION_RETENTION_DAYS` is set

## Limitations

- Implements only Mailgun API subset Ghost uses
- No attachment support
- Event processing is near-real-time via SQS polling
- SQLite setup is single-instance oriented

## License

MIT
