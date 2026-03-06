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
| **Newsletter** | Bulk subscriber emails | Ghost → bridge API (Fake Mailgun) → MySQL + SQS → bridge worker → SES |

For **event tracking** (deliveries, opens, clicks, bounces, complaints), the flow goes the other direction:

```
Ghost send request → API → MySQL batch/job rows → SQS send queue → worker → SES
SES → SNS → SQS → worker → MySQL events/suppressions
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

- `DATABASE_URL` — MySQL connection string for the bridge
- `MAILGUN_DOMAIN` — the domain value Ghost sends (for example `yourdomain.com`)
- `PROXY_API_KEY` — the API key Ghost will use to authenticate (you pick this)
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
- `SES_EVENTS_QUEUE_URL` — your SQS queue that receives SES events
- `NEWSLETTER_SEND_QUEUE_URL` — your dedicated SQS queue for outbound newsletter jobs
- `GHOST_ADMIN_URL` — recommended if you want Ghost session auth on `/ghost/mail`

See [Configuration variables](#configuration-variables) for quick-start options.
For advanced tuning, see [Advanced configuration](./site/docs/advanced-config.md).

### 2. Start the bridge

**With Docker (recommended):**

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

**Without Docker:**

You'll need Node.js 20+ and a reachable MySQL instance.

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
    "batches": 0,
    "send_jobs": 0,
    "recipient_emails": 0,
    "events": 0,
    "suppressions": 0
  }
}
```

### 4. Point Ghost at the bridge

Ghost uses two lanes:

- transactional mail goes straight to SES SMTP
- newsletter mail goes to the bridge over Docker's internal network

#### Same Docker Compose project

If Ghost and the bridge are in the same Compose project, set up both email lanes in your Ghost service config:

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

#### Official `ghost-docker` sidecar install

If Ghost is running from the official `ghost-docker` stack in `/opt/ghost` and the bridge is running separately in `/opt/ghost-mail-bridge`, use this tested pattern:

1. Attach only the bridge API service to Ghost's existing Docker network.

Detect the real network name:

```bash
docker network ls --format '{{.Name}}' | grep ghost_network
```

Then update `/opt/ghost-mail-bridge/docker-compose.yml` so `ghost-mail-bridge` joins that external network:

```yaml
services:
  ghost-mail-bridge:
    networks:
      - default
      - ghost_network

networks:
  ghost_network:
    external: true
    name: your_real_ghost_network_name
```

2. Set Ghost's transactional SMTP lane in `/opt/ghost/.env`:

```env
mail__transport=SMTP
mail__from="Your Site <hello@yourdomain.com>"
mail__options__host=email-smtp.YOUR_AWS_REGION.amazonaws.com
mail__options__port=587
mail__options__secure=false
mail__options__auth__user=YOUR_SES_SMTP_USERNAME
mail__options__auth__pass=YOUR_SES_SMTP_PASSWORD
```

3. Set Ghost's newsletter lane in `/opt/ghost/.env`:

```env
bulkEmail__mailgun__baseUrl=http://ghost-mail-bridge:3003/v3
bulkEmail__mailgun__apiKey=your-secure-api-key-here
bulkEmail__mailgun__domain=yourdomain.com
```

4. Expose the bridge dashboard in `/opt/ghost/caddy/Caddyfile` before the default Ghost proxy:

```caddy
handle /ghost/mail* {
	reverse_proxy ghost-mail-bridge:3003
}

handle {
	reverse_proxy ghost:2368
}
```

5. Restart Caddy and Ghost:

```bash
cd /opt/ghost
docker compose up -d --force-recreate caddy ghost
```

6. Sync Ghost's stored Mailgun settings once so old DB values do not override the new bridge target:

```bash
cd /opt/ghost-mail-bridge
bash scripts/sync-ghost-mailgun-settings.sh
```

Ghost should continue calling the bridge internally at `http://ghost-mail-bridge:3003/v3`. You do not need to expose `/v3` publicly.

Ghost and `ghost-mail-bridge` should be on the same Docker network. If you are migrating an existing Ghost install that was already configured for Mailgun, update the stored `mailgun_base_url` once so Ghost stops calling the old host.

For Docker-based Ghost installs, you can use the migration helper instead of opening the database manually:

```bash
bash scripts/sync-ghost-mailgun-settings.sh
```

Optional convenience alias:

```bash
npm run ghost:sync-mailgun-settings
```

It reads the existing Ghost DB credentials from the running Ghost container, updates the stored Mailgun settings to `http://ghost-mail-bridge:3003/v3`, and restarts Ghost. Treat it as part of install and upgrade hygiene for migrated sites or any Ghost instance that previously pointed at Mailgun.

If you ever want to switch the stored settings back to Mailgun, run:

```bash
MAILGUN_BASE_URL=https://api.mailgun.net/v3 \
MAILGUN_API_KEY=your-real-mailgun-api-key \
MAILGUN_DOMAIN=mg.yourdomain.com \
bash scripts/reset-ghost-mailgun-settings.sh
```

### 5. Optional isolated host install

If you want a Ghost-like `/opt/ghost-mail-bridge` deployment with separate API and worker services, use the templates in [`deploy/README.md`](./deploy/README.md), [`deploy/systemd/ghost-mail-bridge-api.service`](./deploy/systemd/ghost-mail-bridge-api.service), [`deploy/systemd/ghost-mail-bridge-worker.service`](./deploy/systemd/ghost-mail-bridge-worker.service), and [`deploy/caddy/Caddyfile.example`](./deploy/caddy/Caddyfile.example).

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

It shows send summaries, queued/processing/failed batch counts, worker status, and SES-event poller status. Authentication uses your Ghost admin session by default. Set `GHOST_ADMIN_URL` to your Ghost HTTPS URL.

If you're using the official Ghost Docker stack, Caddy must proxy `/ghost/mail*` to `ghost-mail-bridge:3003` before the default Ghost route. The bridge dashboard is the only path that needs public proxying. Keep `/v3` internal between Ghost and the bridge.

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

1. **SES** — a verified domain identity and a Configuration Set
2. **SNS** — a topic that SES publishes events to
3. **SQS (events)** — a queue subscribed to that SNS topic for SES delivery/open/click/bounce/complaint events
4. **SQS (newsletter send)** — a dedicated outbound queue for newsletter batch jobs
5. **SQS DLQ (optional)** — useful for operations, but not required for the app to run
6. **MySQL** — a dedicated bridge database (preferred over sharing Ghost’s DB)
7. **Bridge IAM user** — AWS API credentials for SES + SQS
8. **SES SMTP credentials** — separate credentials for Ghost transactional mail

The IAM user/role for the bridge needs these permissions:

- `ses:SendRawEmail`
- `sqs:SendMessage` on the newsletter send queue
- `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on the newsletter send queue and SES event queue

Make sure:

- your SNS topic policy allows `ses.amazonaws.com` to publish to the topic
- your SQS queue policy only allows your SNS topic to publish to it (`aws:SourceArn`)
- SES, SNS, SQS, and credentials all use the same AWS region
- if your SES account is still in sandbox, test sends must go only to verified recipients or mailbox simulator addresses

---

## Limitations

A few things to be aware of:

- Only implements the slice of the Mailgun API that Ghost actually uses — this isn't a general-purpose Mailgun replacement.
- **No attachment support**.
- Event tracking is not instant.
- This release does not migrate old SQLite data. Keep the old file as backup/reference only.

---

## Reference

### API endpoints

#### Mailgun-compatible (used by Ghost)

| Method | Path | What it does |
|--------|------|-------------|
| `POST` | `/v3/:domain/messages` | Queue bulk email send via SES worker |
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
| `DATABASE_URL` | MySQL connection string for the bridge |
| `SES_EVENTS_QUEUE_URL` | SQS queue URL for SES events |
| `NEWSLETTER_SEND_QUEUE_URL` | Dedicated SQS queue URL for outbound newsletter jobs |
| `PROXY_API_KEY` | API key Ghost uses to authenticate (you choose this) |
| `MAILGUN_DOMAIN` | Domain value Ghost sends (e.g., `mg.yourdomain.com`) |

#### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_REGION` | `us-east-1` | AWS region |
| `APP_ROLE` | `all` | Runtime role: `api`, `worker`, or `all` |
| `SES_CONFIGURATION_SET` | `ghost-mail-bridge` | SES Configuration Set name |
| `PORT` | `3003` | HTTP port |
| `LOG_LEVEL` | `info` | Set `debug` for per-recipient logs |
| `SEND_CONCURRENCY` | `10` | Max parallel SES sends |
| `SEND_BATCH_SIZE` | `1000` | Max recipients per Ghost-like worker batch |
| `SEND_BATCH_CONCURRENCY` | `2` | Max parallel worker batches per send job |
| `SUPPRESSION_RETENTION_DAYS` | `0` | Suppression retention (`0` = forever) |
| `ADMIN_BASE_PATH` | `/ghost/mail` | Dashboard URL path |
| `GHOST_ADMIN_URL` | *(empty)* | Ghost HTTPS base URL for dashboard auth (required if using dashboard) |
| `ALLOW_INSECURE_GHOST_ADMIN_URL` | `false` | Allow `http://` Ghost admin URL only for trusted local/private setups |
| `NEWSLETTER_SEND_DLQ_URL` | *(empty)* | Optional DLQ URL for docs/ops parity |

<details>
<summary>Advanced configuration (optional)</summary>

For retry/backoff tuning, request-size limits, Ghost Admin API compatibility overrides, and local dev/testing switches, see [Advanced configuration](./site/docs/advanced-config.md) and [`.env.advanced.example`](./.env.advanced.example).

</details>

### Storage

The bridge now uses MySQL only.

Core tables: `batches`, `send_jobs`, `recipient_emails`, `events`, `suppressions`, `runtime_heartbeats`.

Daily cleanup removes batch/send/event data older than the configured retention windows. Suppressions are kept forever unless `SUPPRESSION_RETENTION_DAYS` is set.

### Local development

```bash
cp .env.example .env
npm install
npm run dev         # API + worker in one process
# or split roles locally:
npm run dev:api
npm run dev:worker
```

For dashboard-only work without AWS, use the local dev/testing switches documented in [Advanced configuration](./site/docs/advanced-config.md).

---

## License

MIT
