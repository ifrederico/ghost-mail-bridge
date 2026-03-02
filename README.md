# ghost-ses-proxy

Send Ghost newsletter emails through **AWS SES** instead of Mailgun. This proxy impersonates the Mailgun API so Ghost doesn't know the difference — no Ghost code changes required. At scale, SES costs a fraction of Mailgun: sending 600k+ emails/month costs ~$60 on SES vs ~$800 on Mailgun.

Maintained fork: `https://github.com/ifrederico/ghost-ses-proxy`

## How it works

Ghost only supports Mailgun for bulk newsletter sending. This proxy sits between Ghost and AWS SES, translating Mailgun API calls into SES operations and feeding delivery events back in the format Ghost expects.

```
Sending:
  Ghost ──POST /v3/:domain/messages──▶ ghost-ses-proxy ──SES SendRawEmail──▶ AWS SES ──▶ Recipients

Events (delivery, opens, clicks, bounces, complaints):
  AWS SES ──▶ SNS Topic ──▶ SQS Queue ──▶ ghost-ses-proxy ──▶ SQLite
  Ghost ──GET /v3/:domain/events──▶ ghost-ses-proxy ──▶ reads from SQLite
```

The proxy handles:
- **Sending** — Parses Mailgun multipart form data, substitutes `%recipient.*%` template variables, builds raw MIME messages, sends via SES with concurrency limiting
- **Event tracking** — Polls SQS for SES events (delivery, open, click, bounce, complaint), maps them to Mailgun event format, stores in SQLite
- **Suppressions** — Automatically records permanent bounces and complaints; Ghost can delete suppressions via the Mailgun API
- **Authentication** — Validates Ghost's Mailgun Basic auth against your configured API key
- **Input hardening** — Rejects header injection attempts and enforces request/form/recipient limits to protect service availability

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/ifrederico/ghost-ses-proxy.git
cd ghost-ses-proxy
cp .env.example .env
# Edit .env with your AWS credentials and settings
```

### 2. Run with Docker Compose

```bash
# Using the example compose file
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

Or add to your existing Ghost compose stack:

```yaml
services:
  ghost-ses-proxy:
    build: ./ghost-ses-proxy
    ports:
      - "3003:3003"
    volumes:
      - ./ghost-ses-proxy-data:/data
    env_file:
      - ./ghost-ses-proxy/.env
    restart: unless-stopped
```

### 3. Verify the proxy is running

```bash
curl http://localhost:3003/health
# {"status":"ok","tables":{"message_map":0,"recipient_emails":0,"events":0,"suppressions":0}}
```

### 4. Configure Ghost's two email lanes

Ghost has two built-in email lanes. Keep both, but use SES in both:

- **Transactional lane** (`mail__...`) → SES SMTP
- **Newsletter lane** (`bulkEmail__mailgun__...`) → this proxy → SES

Example Ghost service environment:

```yaml
services:
  ghost:
    environment:
      # Transactional lane: sign-in links, password reset, staff notifications
      mail__transport: SMTP
      mail__from: '"Example Site" <noreply@example.com>'
      mail__options__host: email-smtp.us-east-1.amazonaws.com
      mail__options__port: 587
      mail__options__secure: "false"
      mail__options__auth__user: ${SES_SMTP_USERNAME}
      mail__options__auth__pass: ${SES_SMTP_PASSWORD}

      # Newsletter lane: Ghost's Mailgun-compatible bulk API client
      bulkEmail__mailgun__baseUrl: http://ghost-ses-proxy:3003/v3
      bulkEmail__mailgun__apiKey: ${PROXY_API_KEY}
      bulkEmail__mailgun__domain: ${MAILGUN_DOMAIN}
```

Notes:

- Keep `PROXY_API_KEY` and `MAILGUN_DOMAIN` on the proxy. They are required for Ghost's Mailgun API compatibility lane.
- Do not rewire Ghost transactional mail to a custom API endpoint if SMTP with SES works.
- Do not collapse Ghost into one path; this setup keeps Ghost's native architecture and unifies only the provider.

### 5. Cutover validation checklist

Before removing old Mailgun secrets, validate all flows:

- Sign-in magic link works (transactional lane via SES SMTP)
- Password reset works (transactional lane via SES SMTP)
- Staff invite/notification emails work (transactional lane via SES SMTP)
- Newsletter send works (newsletter lane via proxy + SES)
- Delivery/open/click/bounce/complaint events still appear in Ghost

After all checks pass, remove legacy real-Mailgun secrets (for example `MAILGUN_API_KEY` / `mailgun_api_key`) and restart services. Keep `bulkEmail__mailgun__apiKey` + `bulkEmail__mailgun__domain` for proxy compatibility.

## AWS setup guide

You need four AWS resources: a verified SES domain, a Configuration Set, an SNS topic, and an SQS queue.

### 1. Verify your domain in SES

In the AWS Console under **SES > Verified identities**, add your sending domain. Complete DNS verification by adding the DKIM CNAME records to your domain's DNS.

### 2. Create an SES Configuration Set

Under **SES > Configuration sets**, create one named `ghost-ses-proxy` (or whatever you set in `SES_CONFIGURATION_SET`).

Add an **SNS event destination** that publishes these event types:
- Sends
- Deliveries
- Opens
- Clicks
- Bounces
- Complaints
- Rejects

Point this destination at the SNS topic you'll create next.

### 3. Create an SNS topic

Create a standard SNS topic (e.g., `ghost-ses-events`). No special configuration needed — it just bridges SES to SQS.

### 4. Create an SQS queue

Create a standard SQS queue (e.g., `ghost-ses-events`). Subscribe it to the SNS topic.

Set the queue's access policy to allow your SNS topic to send messages:

```json
{
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "sns.amazonaws.com"},
    "Action": "sqs:SendMessage",
    "Resource": "arn:aws:sqs:REGION:ACCOUNT:ghost-ses-events",
    "Condition": {
      "ArnEquals": {
        "aws:SourceArn": "arn:aws:sns:REGION:ACCOUNT:ghost-ses-events"
      }
    }
  }]
}
```

### 5. Create an IAM user

Create an IAM user with programmatic access and attach this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ses:SendRawEmail"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:REGION:ACCOUNT:ghost-ses-events"
    }
  ]
}
```

Use this user's access key and secret in your `.env`.

## API reference

The proxy implements the subset of the Mailgun API that Ghost actually uses:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/health` | Health check (unauthenticated) — returns table row counts |
| `POST` | `/v3/:domain/messages` | Send email — accepts Mailgun multipart form data |
| `GET` | `/v3/:domain/events` | Fetch events — supports Mailgun query params (`event`, `tags`, `begin`, `end`, `limit`) |
| `GET` | `/v3/:domain/events/:pageToken` | Fetch next page of events (cursor-based pagination) |
| `DELETE` | `/v3/:domain/:type/:email` | Delete a suppression (bounces, complaints, unsubscribes) |

All `/v3/*` endpoints require Basic auth with any username and your `PROXY_API_KEY` as the password (matching Mailgun's auth scheme).

## Configuration reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_ACCESS_KEY_ID` | Yes | — | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | — | IAM secret key |
| `AWS_REGION` | No | `us-east-1` | AWS region for SES and SQS |
| `SQS_QUEUE_URL` | Yes | — | Full SQS queue URL |
| `SES_CONFIGURATION_SET` | No | `ghost-ses-proxy` | SES Configuration Set name |
| `PROXY_API_KEY` | Yes | — | API key Ghost sends as `bulkEmail__mailgun__apiKey` (Mailgun-compatible auth) |
| `MAILGUN_DOMAIN` | Yes | — | Domain Ghost sends as `bulkEmail__mailgun__domain` (Mailgun-compatible API field) |
| `PORT` | No | `3003` | HTTP port |
| `LOG_LEVEL` | No | `info` | Set to `debug` for per-recipient send logs |
| `SEND_CONCURRENCY` | No | `10` | Max parallel SES sends per batch |
| `SUPPRESSION_RETENTION_DAYS` | No | `0` | Days to retain suppressions; `0` keeps suppressions indefinitely |
| `MAX_REQUEST_BYTES` | No | `10485760` (10MB) | Max accepted request size based on `Content-Length` |
| `MAX_FORM_FIELDS` | No | `2000` | Max number of multipart form fields |
| `MAX_FIELD_SIZE_BYTES` | No | `2097152` (2MB) | Max size for each multipart field value |
| `MAX_RECIPIENTS` | No | `50000` | Max recipients accepted in a single send request |
| `MAX_CUSTOM_HEADERS` | No | `100` | Max number of custom `h:*` headers per request |

## Event pipeline detail

1. Ghost sends a newsletter → proxy receives multipart form data at `POST /v3/:domain/messages`
2. Proxy parses recipients, substitutes `%recipient.*%` template variables, builds raw MIME for each recipient
3. Each email sent via SES `SendRawEmail` with the configured Configuration Set
4. Proxy stores a mapping: SES Message ID → Ghost batch ID + email ID + recipient
5. SES generates events (delivery, open, click, bounce, complaint) → publishes to SNS → SQS
6. Proxy's SQS poller (long-polling, 20s interval) receives events, maps SES event types to Mailgun equivalents, correlates with stored send data, writes to SQLite
7. Ghost polls `GET /v3/:domain/events` → proxy queries SQLite, returns Mailgun-format event objects with cursor pagination

### Event type mapping

| SES Event | Mailgun Event | Notes |
|-----------|--------------|-------|
| Delivery | `delivered` | |
| Open | `opened` | |
| Click | `clicked` | |
| Bounce (Permanent) | `failed` (severity: permanent) | Also creates suppression |
| Bounce (Transient) | `failed` (severity: temporary) | |
| Complaint | `complained` | Also creates suppression |
| Reject | `failed` (severity: permanent) | Also creates suppression |
| Send, DeliveryDelay | *(skipped)* | No Mailgun equivalent |

## Database

The proxy uses SQLite (via `better-sqlite3`) stored at `/data/ses-proxy.db`. Four tables:

- **message_map** — Batch metadata from send requests (Ghost email ID, tags)
- **recipient_emails** — Maps SES message IDs to batch/recipient for event correlation
- **events** — Normalized events in Mailgun format, queried by Ghost
- **suppressions** — Permanent bounces and complaints

A cleanup job runs daily. By default, send/event mapping data older than 90 days is deleted, while suppressions are retained indefinitely (unless `SUPPRESSION_RETENTION_DAYS` is set).

## Limitations

- Only implements the Mailgun API endpoints Ghost uses — not a general-purpose Mailgun replacement
- No support for attachments (Ghost newsletters don't use them)
- Event polling is near-real-time (SQS long-poll), not instant webhooks
- SQLite is single-node; this proxy is designed to run as a single instance

## License

MIT
