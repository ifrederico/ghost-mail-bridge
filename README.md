# ghost-mail-bridge

**Use AWS SES to send your Ghost newsletter emails without changing anything in Ghost.**

Ghost has built-in support for Mailgun to send newsletters. But if you'd rather use AWS SES (it's cheaper), this bridge sits between Ghost and SES and translates between them. Ghost thinks it's talking to Mailgun. SES does the actual sending.

No Ghost code changes.

> Originally based on [ghost-ses-proxy](https://github.com/josephsellers/ghost-ses-proxy), now independently maintained at [ghost-mail-bridge](https://github.com/ifrederico/ghost-mail-bridge).

---

## What happens?

Ghost sends emails through two separate “lanes”:

| Lane | What it sends | How it works with the bridge |
|------|--------------|------|
| **Transactional** | Magic links, password resets, staff invites | SES via SMTP (no bridge needed) |
| **Newsletter** | Bulk subscriber emails | Ghost → bridge (Fake Mailgun) → SES |

For **event tracking** (deliveries, opens, clicks, bounces, complaints), the flow goes the other direction:

```
SES → SNS → SQS → bridge (polls the queue) → stores in SQLite
                                                     ↑
                                          Ghost reads events from here
```

Ghost mail bridge also includes a **admin dashboard** so you can see what's going on without digging through logs.

---

## Getting started

### 1. Clone and configure

```bash
git clone https://github.com/ifrederico/ghost-mail-bridge.git
cd ghost-mail-bridge
cp .env.example .env
```

Open `.env` and fill in your AWS credentials and settings. At minimum you'll need:

- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
- `SQS_QUEUE_URL` — your SQS queue that receives SES events
- `PROXY_API_KEY` — the API key Ghost will use to authenticate (you pick this)
- `MAILGUN_DOMAIN` — the domain value Ghost sends (e.g., `mg.yourdomain.com`)

See [Configuration variables](#configuration-variables) for the full list of options.

### 2. Start the bridge

**With Docker (recommended):**

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

**Without Docker:**

You'll need Node.js 20+ and build tools for `better-sqlite3` (`python3`, `make`, `g++`).

```bash
npm install
npm run dev
```

### 3. Check that it's running

```bash
curl http://localhost:3003/health
```

You should see something like:

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

### 4. Point Ghost at the bridge

In your Ghost service config (e.g., `docker-compose.yml`), set up both email lanes:

```yaml
services:
  ghost:
    environment:
      # --- Transactional emails (direct to SES via SMTP) ---
      mail__transport: SMTP
      mail__from: '"Your Site" <noreply@yourdomain.com>'
      mail__options__host: email-smtp.us-east-1.amazonaws.com
      mail__options__port: 587
      mail__options__secure: "false"
      mail__options__auth__user: ${SES_SMTP_USERNAME}
      mail__options__auth__pass: ${SES_SMTP_PASSWORD}

      # --- Newsletter emails (through the bridge) ---
      bulkEmail__mailgun__baseUrl: http://ghost-mail-bridge:3003/v3
      bulkEmail__mailgun__apiKey: ${PROXY_API_KEY}
      bulkEmail__mailgun__domain: ${MAILGUN_DOMAIN}
```

That's it. Ghost doesn't know the difference.

---

## Verify everything works

Run through this checklist after setup:

- [ ] **Magic link sign-in** works (transactional lane)
- [ ] **Password reset** works (transactional lane)
- [ ] **Staff invite emails** arrive (transactional lane)
- [ ] **Newsletter send** goes through the bridge (newsletter lane)
- [ ] **Events show up in Ghost** — delivery, opens, clicks

---

## Admin dashboard

The bridge includes a simple dashboard for monitoring at `/ghost/mail` (configurable via `ADMIN_BASE_PATH`).

It shows send summaries, failures, and poller status. Authentication uses your Ghost admin session by default. Just make sure `GHOST_ADMIN_URL` is set.

For local styling/development work without a Ghost session, you can use demo mode:

```
/ghost/mail/?demo=1
```

If you're running behind Nginx, add a proxy rule:

```nginx
location /ghost/mail/ {
  proxy_pass http://ghost-mail-bridge:3003/ghost/mail/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Cookie $http_cookie;
}
```

---

## AWS setup

You'll need these AWS resources:

1. **SES** — a verified domain identity and a Configuration Set (for event publishing)
2. **SNS** — a topic that SES publishes events to
3. **SQS** — a queue subscribed to that SNS topic (plus a dead-letter queue, recommended)

The IAM user/role for the bridge needs these permissions:

- `ses:SendRawEmail`
- `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`

Make sure your SQS policy only allows your SNS topic to publish to it (`aws:SourceArn`).

---

## Limitations

A few things to be aware of:

- Only implements the slice of the Mailgun API that Ghost actually uses — this isn't a general-purpose Mailgun replacement.
- **No attachment support**.
- Event tracking is not instant.
- SQLite means single-instance only — this isn't designed for horizontal scaling.

---

## Reference

### API endpoints

#### Mailgun-compatible (used by Ghost)

| Method | Path | What it does |
|--------|------|-------------|
| `POST` | `/v3/:domain/messages` | Send bulk email via SES |
| `GET` | `/v3/:domain/events` | Fetch events in Mailgun format |
| `GET` | `/v3/:domain/events/:pageToken` | Fetch next event page |
| `DELETE` | `/v3/:domain/:type/:email` | Delete a suppression record |
| `GET` | `/health` | Service status and table counts |

#### Dashboard API

All routes relative to `ADMIN_BASE_PATH` (default: `/ghost/mail`).

| Method | Path | What it does |
|--------|------|-------------|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/health` | Health + poller status |
| `GET` | `/api/summary` | 24h send/event summary |
| `GET` | `/api/failures` | Recent failures and complaints |

### Event mapping

| SES event | Mailgun event | Creates suppression? |
|-----------|--------------|---------------------|
| Delivery | `delivered` | No |
| Open | `opened` | No |
| Click | `clicked` | No |
| Bounce (Permanent) | `failed` (permanent) | Yes |
| Bounce (Transient) | `failed` (temporary) | No |
| Complaint | `complained` | Yes |
| Reject | `failed` (permanent) | Yes |
| Send, DeliveryDelay | *(skipped)* | — |

### Configuration variables

#### Required

| Variable | Description |
|----------|-------------|
| `AWS_ACCESS_KEY_ID` | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key |
| `SQS_QUEUE_URL` | SQS queue URL for SES events |
| `PROXY_API_KEY` | API key Ghost uses to authenticate (you choose this) |
| `MAILGUN_DOMAIN` | Domain value Ghost sends (e.g., `mg.yourdomain.com`) |

#### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_REGION` | `us-east-1` | AWS region |
| `SES_CONFIGURATION_SET` | `ghost-mail-bridge` | SES Configuration Set name |
| `PORT` | `3003` | HTTP port |
| `LOG_LEVEL` | `info` | Set `debug` for per-recipient logs |
| `SEND_CONCURRENCY` | `10` | Max parallel SES sends |
| `SES_SEND_MAX_RETRIES` | `3` | Retries per recipient |
| `SES_RETRY_BASE_MS` | `500` | Base backoff (ms) |
| `SES_RETRY_MAX_MS` | `10000` | Max backoff cap (ms) |
| `SUPPRESSION_RETENTION_DAYS` | `0` | Suppression retention (`0` = forever) |
| `MAX_REQUEST_BYTES` | `10485760` | Max request size (10 MB) |
| `MAX_FORM_FIELDS` | `2000` | Max multipart fields |
| `MAX_FIELD_SIZE_BYTES` | `2097152` | Max field size (2 MB) |
| `MAX_RECIPIENTS` | `50000` | Max recipients per request |
| `MAX_CUSTOM_HEADERS` | `100` | Max `h:*` headers |
| `ADMIN_BASE_PATH` | `/ghost/mail` | Dashboard URL path |
| `GHOST_ADMIN_URL` | *(empty)* | Ghost base URL for dashboard auth (required if using dashboard) |
| `GHOST_ACCEPT_VERSION` | `v6.0` | Ghost Admin API version header |
| `DB_PATH` | *(auto)* | Override SQLite path |

### Storage

SQLite database location (in priority order):

1. `DB_PATH` env var if set
2. `/data/ses-proxy.db` if `/data` is writable (Docker/VPS)
3. `./data/ses-proxy.db` fallback (macOS local dev)

Tables: `message_map`, `recipient_emails`, `events`, `suppressions`.

Daily cleanup removes send/event data older than 90 days. Suppressions are kept forever unless `SUPPRESSION_RETENTION_DAYS` is set.

### Local development

```bash
cp .env.example .env
npm install
npm run dev    # loads .env automatically
```

For dashboard-only work without AWS:

```bash
DISABLE_SQS_POLLER=1 DISABLE_ADMIN_AUTH=1 npm run dev
# Then open /ghost/mail/?demo=1
```

---

## License

MIT
