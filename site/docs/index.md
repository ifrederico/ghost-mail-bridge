---
title: Documentation
layout: docs
---

# Ghost Mail Bridge

Send your Ghost newsletter emails through AWS SES. No Ghost code changes needed.

Ghost has built-in support for Mailgun to send newsletters. Ghost Mail Bridge sits between Ghost and AWS SES, translating the Mailgun API calls that Ghost makes into SES calls. Ghost thinks it's talking to Mailgun. SES does the actual sending.

## How it works

Ghost sends emails through two separate lanes:

| Lane | What it sends | How it works |
|------|--------------|-------------|
| **Transactional** | Magic links, password resets, staff invites | SES via SMTP (no bridge needed) |
| **Newsletter** | Bulk subscriber emails | Ghost → Bridge → SES |

For event tracking (deliveries, opens, clicks, bounces, complaints), the flow goes the other direction:

```
SES → SNS → SQS → Bridge (polls the queue) → SQLite
                                                 ↑
                                      Ghost reads events from here
```

## Getting started

### 1. Clone and configure

```bash
git clone https://github.com/ifrederico/ghost-mail-bridge.git
cd ghost-mail-bridge
cp .env.example .env
```

Open `.env` and fill in your AWS credentials. At minimum you need:

- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
- `SQS_QUEUE_URL` — your SQS queue that receives SES events
- `PROXY_API_KEY` — the API key Ghost will use to authenticate (you pick this)
- `MAILGUN_DOMAIN` — the domain value Ghost sends (e.g. `mg.yourdomain.com`)

### 2. Start the bridge

**With Docker (recommended):**

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

**Without Docker:**

Requires Node.js 20+ and build tools for better-sqlite3 (`python3`, `make`, `g++`).

```bash
npm install
npm run dev
```

### 3. Check that it's running

```bash
curl http://localhost:3003/health
```

You should see:

```json
{
  "status": "ok",
  "tables": {
    "message_map": 0,
    "recipient_emails": 0,
    "events": 0,
    "suppressions": 0
  }
}
```

## Ghost configuration

In your Ghost service config (e.g. `docker-compose.yml`), set up both email lanes:

```yaml
services:
  ghost:
    environment:
      # Transactional emails (direct to SES via SMTP)
      mail__transport: SMTP
      mail__from: '"Your Site" <noreply@yourdomain.com>'
      mail__options__host: email-smtp.us-east-1.amazonaws.com
      mail__options__port: 587
      mail__options__secure: "false"
      mail__options__auth__user: ${SES_SMTP_USERNAME}
      mail__options__auth__pass: ${SES_SMTP_PASSWORD}

      # Newsletter emails (through the bridge)
      bulkEmail__mailgun__baseUrl: http://ghost-mail-bridge:3003/v3
      bulkEmail__mailgun__apiKey: ${PROXY_API_KEY}
      bulkEmail__mailgun__domain: ${MAILGUN_DOMAIN}
```

That's it. Ghost doesn't know the difference.

Ghost and `ghost-mail-bridge` should be on the same Docker network. If you are migrating an existing Ghost install that was already configured for Mailgun, update the stored `mailgun_base_url` once so Ghost stops calling the old host.

For Docker-based Ghost installs, you can use the migration helper instead of opening the database manually:

```bash
bash scripts/sync-ghost-mailgun-settings.sh
```

Optional convenience alias:

```bash
npm run ghost:sync-mailgun-settings
```

It reads the existing Ghost DB credentials from the running Ghost container, updates the stored Mailgun settings to `http://ghost-mail-bridge:3003/v3`, and restarts Ghost. This is optional and mainly useful for migrations.

If you ever want to switch the stored settings back to Mailgun, run:

```bash
MAILGUN_BASE_URL=https://api.mailgun.net/v3 \
MAILGUN_API_KEY=your-real-mailgun-api-key \
MAILGUN_DOMAIN=mg.yourdomain.com \
bash scripts/reset-ghost-mailgun-settings.sh
```

## Verify setup

Run through this checklist after setup:

- Magic link sign-in works (transactional lane)
- Password reset works (transactional lane)
- Staff invite emails arrive (transactional lane)
- Newsletter send goes through the bridge (newsletter lane)
- Events show up in Ghost — delivery, opens, clicks

## Admin dashboard

The bridge includes a dashboard for monitoring at `/ghost/mail` (configurable via `ADMIN_BASE_PATH`). It shows send summaries, delivery rates, failures, and poller status.

Authentication uses your Ghost admin session by default. Set `GHOST_ADMIN_URL` to your Ghost HTTPS URL.

[View the live demo →](../ghost/mail/?demo=1)

If you're running behind Nginx, add a proxy rule:

```nginx
location /ghost/mail/ {
  proxy_pass http://ghost-mail-bridge:3003/ghost/mail/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Cookie $http_cookie;
}
```

## Event tracking

| SES event | Mailgun event | Creates suppression? |
|-----------|--------------|---------------------|
| Delivery | `delivered` | No |
| Open | `opened` | No |
| Click | `clicked` | No |
| Bounce (Permanent) | `failed` (permanent) | Yes |
| Bounce (Transient) | `failed` (temporary) | No |
| Complaint | `complained` | Yes |
| Reject | `failed` (permanent) | Yes |
| Send, DeliveryDelay | *skipped* | — |

## AWS setup

You need these AWS resources:

1. **SES** — a verified domain identity and a Configuration Set (for event publishing)
2. **SNS** — a topic that SES publishes events to
3. **SQS** — a queue subscribed to that SNS topic (plus a dead-letter queue, recommended)

The IAM user/role for the bridge needs:

- `ses:SendRawEmail`
- `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`

Make sure your SQS policy only allows your SNS topic to publish to it (`aws:SourceArn`).

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `AWS_ACCESS_KEY_ID` | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key |
| `SQS_QUEUE_URL` | SQS queue URL for SES events |
| `PROXY_API_KEY` | API key Ghost uses to authenticate (you choose this) |
| `MAILGUN_DOMAIN` | Domain value Ghost sends (e.g. `mg.yourdomain.com`) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_REGION` | `us-east-1` | AWS region |
| `SES_CONFIGURATION_SET` | `ghost-mail-bridge` | SES Configuration Set name |
| `PORT` | `3003` | HTTP port |
| `LOG_LEVEL` | `info` | Set `debug` for per-recipient logs |
| `SEND_CONCURRENCY` | `10` | Max parallel SES sends |
| `SUPPRESSION_RETENTION_DAYS` | `0` | Suppression retention (`0` = forever) |
| `ADMIN_BASE_PATH` | `/ghost/mail` | Dashboard URL path |
| `GHOST_ADMIN_URL` | *empty* | Ghost HTTPS base URL for dashboard auth |
| `ALLOW_INSECURE_GHOST_ADMIN_URL` | `false` | Allow `http://` Ghost admin URL only for trusted local/private setups |
| `DB_PATH` | *auto* | Override SQLite path |

<details>
<summary>Advanced configuration (optional)</summary>

For retry/backoff tuning, request-size limits, Ghost Admin API compatibility overrides, and local dev/testing switches, see [Advanced configuration](./advanced-config.html) and [`.env.advanced.example` on GitHub](https://github.com/ifrederico/ghost-mail-bridge/blob/main/.env.advanced.example).

</details>

## API endpoints

### Mailgun-compatible (used by Ghost)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v3/:domain/messages` | Send bulk email via SES |
| `GET` | `/v3/:domain/events` | Fetch events in Mailgun format |
| `DELETE` | `/v3/:domain/:type/:email` | Delete a suppression record |
| `GET` | `/health` | Service status and table counts |

### Dashboard API

All routes relative to `ADMIN_BASE_PATH` (default: `/ghost/mail`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/health` | Health + poller status |
| `GET` | `/api/summary` | Send/event summary |
| `GET` | `/api/delivery` | Delivery timeline |
| `GET` | `/api/failures` | Recent failures and complaints |
| `GET` | `/api/suppressions` | Suppression list |

## Storage

SQLite database location (in priority order):

1. `DB_PATH` env var if set
2. `/data/ses-proxy.db` if `/data` is writable (Docker/VPS)
3. `./data/ses-proxy.db` fallback (macOS local dev)

Tables: `message_map`, `recipient_emails`, `events`, `suppressions`.

Daily cleanup removes send/event data older than 90 days. Suppressions are kept forever unless `SUPPRESSION_RETENTION_DAYS` is set.

## Limitations

- Only implements the Mailgun API surface that Ghost actually uses — not a general-purpose Mailgun replacement.
- No attachment support.
- Event tracking is not instant — the bridge polls SQS on an interval.
- SQLite means single-instance only — not designed for horizontal scaling.
