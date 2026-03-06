# Ghost Mail Bridge Setup Steps

This is a working draft for the install flow.
It does not change the public docs yet.

## Content recommendation

If this becomes public docs, I recommend:

- screenshots for the AWS console steps
- one short end-to-end video for the whole install
- not a separate video for every tiny step

Best places for screenshots:

- SES verified identity
- SES configuration set + event destination
- SNS topic subscription
- SQS queue + DLQ + queue policy
- Ghost env snippet
- working `/ghost/mail` dashboard

## Goal

Use AWS SES for:

- Ghost transactional email via SMTP
- Ghost newsletter email via `ghost-mail-bridge`

Without changing Ghost source code.

## Tested install shape

This is the install path we validated on a live Ubuntu 24 server:

```text
/opt/ghost               # official ghost-docker install
/opt/ghost-mail-bridge   # bridge repo + separate compose stack
```

The bridge branch used during validation was:

```text
codex/queue-first-bridge
```

## Current scope

This version of the bridge:

- keeps Ghost's Mailgun-compatible API surface
- queues newsletter sends immediately into SQS
- processes newsletter sends asynchronously in a worker
- processes SES delivery/open/click/bounce/complaint events asynchronously through SNS -> SQS

That means:

- Ghost gets an immediate `Queued. Thank you.` style response
- large newsletters no longer block Ghost on inline SES work
- the tested install path is the official `ghost-docker` stack in `/opt/ghost` plus a separate `/opt/ghost-mail-bridge` stack

## 1. AWS Setup

### 1.1 Verify your sending domain in SES

In AWS SES:

- create or open your verified identity for the domain you send from
- finish DNS verification
- finish DKIM setup

You should be able to send email from the domain before moving on.

Recommended screenshot:

- SES identity page showing verified status and DKIM enabled

Important:

- if your AWS account is still in the SES sandbox, newsletter sends to arbitrary recipients will fail
- move SES out of sandbox before treating the bridge as production-ready

### 1.2 Create an SES Configuration Set

Create one configuration set.

Suggested new name:

```text
ghost-mail-bridge
```

You can use another name, or keep an existing name. The only rule is:

- `SES_CONFIGURATION_SET` must exactly match the real SES configuration set name

If your setup already works with an existing configuration set name, do not rename it just to match the app name.

Example existing name from a migrated setup:

```text
ghost-ses-proxy
```

### 1.3 Create an SNS topic

Create an SNS topic for SES event publishing.

Suggested new topic name:

```text
ghost-mail-bridge-events
```

### 1.4 Create the SQS queues

Create:

- an SQS queue subscribed to the SNS topic for SES events
- a dedicated SQS send queue for newsletter jobs
- an optional send DLQ if you want safer ops

Suggested event queue name:

```text
ghost-mail-bridge-events
```

Suggested send queue names:

- `ghost-mail-bridge-send`
- `ghost-mail-bridge-send-dlq`

Suggested new-name shape:

- SNS topic:
  - `ghost-mail-bridge-events`
- SQS queue:
  - `ghost-mail-bridge-events`
- SQS send queue:
  - `ghost-mail-bridge-send`
- SQS send dead-letter queue:
  - `ghost-mail-bridge-send-dlq`

There should be an SNS subscription from the topic to the main SQS queue.

Example existing names from a migrated setup:

- SNS topic:
  - `ghost-ses-events`
- SQS queue:
  - `ghost-ses-events`
- SQS DLQ:
  - `ghost-ses-events-dlq`
- SES event destination:
  - `ghost-ses-events-destination`

### 1.5 Add an SES event destination

In the SES Configuration Set, add an event destination that publishes to the SNS topic.

Enable these event types:

- Deliveries
- Opens
- Clicks
- Bounces
- Complaints
- Rejects

`Send` and `DeliveryDelay` are not important for Ghost compatibility here.

Example shape:

- configuration set:
  - `ghost-mail-bridge`
- event destination:
  - `ghost-mail-bridge-events-destination`
- target:
  - SNS topic `ghost-mail-bridge-events`

If you already have working names like `ghost-ses-proxy` and `ghost-ses-events`, keep them and make your env/config match them.

### 1.6 Create the SES SMTP credentials for Ghost transactional mail

This is for Ghost’s transactional lane only:

- magic links
- password resets
- staff invites

This is usually the AWS-generated SES SMTP user/credentials.

This is not the same credential the bridge uses.

Example policy shape:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SmtpSendOnly",
      "Effect": "Allow",
      "Action": "ses:SendRawEmail",
      "Resource": "arn:aws:ses:REGION:ACCOUNT_ID:identity/domain.pt",
      "Condition": {
        "StringEquals": {
          "ses:FromAddress": [
            "noreply@domain.pt",
            "newsletter@domain.pt"
          ]
        }
      }
    }
  ]
}
```

### 1.7 Create IAM credentials for the bridge app

The bridge needs:

- `ses:SendRawEmail`
- `sqs:SendMessage`
- `sqs:ReceiveMessage`
- `sqs:DeleteMessage`
- `sqs:GetQueueAttributes`

Use a dedicated IAM user or role.

Important:

- the SMTP user and the bridge app user should be treated as separate credentials
- Ghost transactional SMTP can use the SES SMTP user
- `ghost-mail-bridge` should use its own AWS access key / secret

If you lock the policy down, make sure the bridge app user can send using:

- the SES identity you verified
- the SES configuration set named in `SES_CONFIGURATION_SET`
- the SQS queue used for SES event delivery

This matters because the bridge sends with `ConfigurationSetName`, and SES may reject the request if the IAM policy only allows the identity but not the configuration set.

Example policy shape:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BridgeSendQueue",
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl"
      ],
      "Resource": "arn:aws:sqs:REGION:ACCOUNT_ID:your-real-send-queue-name"
    },
    {
      "Sid": "BridgeConsumeQueues",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl"
      ],
      "Resource": [
        "arn:aws:sqs:REGION:ACCOUNT_ID:your-real-events-queue-name",
        "arn:aws:sqs:REGION:ACCOUNT_ID:your-real-send-queue-name"
      ]
    },
    {
      "Sid": "BridgeSendIdentity",
      "Effect": "Allow",
      "Action": "ses:SendRawEmail",
      "Resource": "arn:aws:ses:REGION:ACCOUNT_ID:identity/domain.pt",
      "Condition": {
        "StringLike": {
          "ses:FromAddress": [
            "newsletter@domain.pt",
            "noreply@domain.pt"
          ]
        }
      }
    },
    {
      "Sid": "BridgeUseConfigurationSet",
      "Effect": "Allow",
      "Action": "ses:SendRawEmail",
      "Resource": "arn:aws:ses:REGION:ACCOUNT_ID:configuration-set/your-real-configuration-set-name"
    }
  ]
}
```

Change the ARN values to match your real AWS names.

### 1.8 SNS topic policy and SQS queue policy

Your SNS topic policy should allow `ses.amazonaws.com` to publish to the topic for your account.

Your SQS event queue policy should allow only your SNS topic to publish into it.

At minimum, scope the policy using:

- `aws:SourceArn`

Preferably also scope with:

- `aws:SourceAccount`

Example queue policy shape:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSnsPublish",
      "Effect": "Allow",
      "Principal": {
        "Service": "sns.amazonaws.com"
      },
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:REGION:ACCOUNT_ID:your-real-sqs-queue-name",
      "Condition": {
        "ArnEquals": {
          "aws:SourceArn": "arn:aws:sns:REGION:ACCOUNT_ID:your-real-sns-topic-name"
        },
        "StringEquals": {
          "aws:SourceAccount": "ACCOUNT_ID"
        }
      }
    }
  ]
}
```

### 1.9 Things you usually do not need to document in the install flow

These often exist in AWS accounts but are not part of the bridge install itself:

- service-linked roles like `AWSServiceRoleForSupport`
- service-linked roles like `AWSServiceRoleForTrustedAdvisor`
- service-linked roles like `AWSServiceRoleForResourceExplorer`

They are not part of the required bridge setup.

## 2. Bridge Setup

### 2.1 Clone and configure

```bash
git clone https://github.com/ifrederico/ghost-mail-bridge.git /opt/ghost-mail-bridge
cd /opt/ghost-mail-bridge
git checkout codex/queue-first-bridge
cp .env.example .env
cp docker-compose.example.yml docker-compose.yml
```

Generate a bridge API key:

```bash
openssl rand -hex 32
```

Set at least:

```env
DATABASE_URL=mysql://ghost_mail_bridge:ghost_mail_bridge@mysql:3306/ghost_mail_bridge
MAILGUN_DOMAIN=your-domain.com
GHOST_ADMIN_URL=https://yourdomain.com
PROXY_API_KEY=choose-a-random-secret
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
SES_EVENTS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/your-real-events-queue
NEWSLETTER_SEND_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/your-real-send-queue
SES_CONFIGURATION_SET=your-real-configuration-set-name
ADMIN_BASE_PATH=/ghost/mail
```

Important:

- use your actual AWS resource names here
- do not rename working AWS resources unless you want to
- your queue/config-set names can stay `ghost-ses-events` / `ghost-ses-proxy` if that is what already exists

Recommended screenshot:

- bridge `.env` values side by side with the real AWS names they match

### 2.2 Start the bridge

```bash
cd /opt/ghost-mail-bridge
docker compose up -d
```

If Ghost is running in a separate Docker Compose project, attach only the `ghost-mail-bridge` API service to Ghost's external Docker network so Ghost can call `http://ghost-mail-bridge:3003/v3`.

Detect Ghost's real network name:

```bash
docker network ls --format '{{.Name}}' | grep ghost_network
```

Then update `/opt/ghost-mail-bridge/docker-compose.yml`:

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

### 2.3 Confirm health

```bash
curl http://localhost:3003/health
```

Expected:

```json
{"status":"ok","tables":{"batches":0,"send_jobs":0,"recipient_emails":0,"events":0,"suppressions":0}}
```

## 3. Ghost Setup

Ghost needs two email lanes.

### 3.1 Transactional lane

Ghost transactional email should go directly to SES SMTP.

Example:

```yaml
mail__transport: SMTP
mail__from: '"Your Site" <noreply@yourdomain.com>'
mail__options__host: email-smtp.us-east-1.amazonaws.com
mail__options__port: 587
mail__options__secure: "false"
mail__options__auth__user: ${SES_SMTP_USERNAME}
mail__options__auth__pass: ${SES_SMTP_PASSWORD}
```

These SMTP credentials come from the SES SMTP user, not from the bridge app IAM user.

Recommended screenshot:

- Ghost transactional email env section

### 3.2 Newsletter lane

Ghost newsletter email should go to the bridge service over the internal Docker network.

Example:

```yaml
bulkEmail__mailgun__baseUrl: http://ghost-mail-bridge:3003/v3
bulkEmail__mailgun__apiKey: ${PROXY_API_KEY}
bulkEmail__mailgun__domain: ${MAILGUN_DOMAIN}
```

Important:

- Ghost and `ghost-mail-bridge` should be on the same Docker network
- Ghost should talk to `ghost-mail-bridge:3003`
- do not send Ghost through the public domain for `/v3`
- do not point Ghost newsletter sends at a public host like `http://your-server:3003/v3` unless you intentionally want the bridge exposed publicly

Recommended screenshot:

- Ghost newsletter env section showing `bulkEmail__mailgun__baseUrl`

### 3.3 Dashboard route

If you use the official Ghost Docker stack, Caddy already fronts the public domain and is already on Ghost's Docker network. Add this route before the default Ghost proxy in `/opt/ghost/caddy/Caddyfile`:

```caddy
handle /ghost/mail* {
	reverse_proxy ghost-mail-bridge:3003
}
```

The dashboard is the only bridge path that needs public proxying. Keep `/v3` internal between Ghost and the bridge.

### 3.4 Restart Ghost and Caddy

After setting those values, restart Ghost and the proxy if needed.

For the official `ghost-docker` stack, the tested commands were:

```bash
cd /opt/ghost
docker compose up -d --force-recreate caddy ghost
```

Also make sure the `ghost` service in `/opt/ghost/compose.yml` joins the bridge network:

```yaml
    networks:
      - ghost_network
      - ghost_mail_bridge_network
```

And define the external bridge network at the bottom of `/opt/ghost/compose.yml`:

```yaml
networks:
  ghost_network:
  ghost_mail_bridge_network:
    external: true
    name: your_real_ghost_network_name
```

## 4. Migration Case

If this is a fresh install, stop here.

If this Ghost instance previously used Mailgun or another bridge, Ghost may still have old stored Mailgun settings in its database.

That can cause Ghost to keep calling the old Mailgun host even after you update env/config.

### 4.1 Migration helper

Run:

```bash
cd /opt/ghost-mail-bridge
bash scripts/sync-ghost-mailgun-settings.sh
```

Convenience alias:

```bash
npm run ghost:sync-mailgun-settings
```

What it does:

- reads Ghost DB connection settings from the running Ghost container
- updates stored:
  - `mailgun_base_url`
  - `mailgun_api_key`
  - `mailgun_domain`
- restarts Ghost

This is only for migration/fixup, but in practice it should be treated as part of install and upgrade hygiene.

Recommended screenshot:

- terminal output from a successful `sync-ghost-mailgun-settings.sh` run

## 5. Optional Reset Back to Mailgun

If someone wants to undo the migration and return Ghost’s stored settings to Mailgun:

```bash
MAILGUN_BASE_URL=https://api.mailgun.net/v3 \
MAILGUN_API_KEY=your-real-mailgun-api-key \
MAILGUN_DOMAIN=mg.yourdomain.com \
bash scripts/reset-ghost-mailgun-settings.sh
```

Convenience alias:

```bash
npm run ghost:reset-mailgun-settings
```

## 6. Dashboard Setup

The dashboard path is:

```text
/ghost/mail
```

If you run a reverse proxy like Nginx:

```nginx
location /ghost/mail/ {
  proxy_pass http://ghost-mail-bridge:3003/ghost/mail/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Cookie $http_cookie;
}
```

If you use Caddy or another proxy, the idea is the same:

- public path `/ghost/mail/*`
- proxy to bridge path `/ghost/mail/*`

Recommended screenshot:

- a working `/ghost/mail` dashboard page after login

## 7. Verify Everything

### 7.1 Auth checks

Logged-in browser:

- open `/ghost/mail`
- dashboard should load

Incognito browser:

- open `/ghost/mail`
- dashboard should not load as an authenticated user

Fake cookie check:

```bash
curl -i -H 'Cookie: anything=1' https://yourdomain.com/ghost/mail/api/summary
```

Expected:

- `401`
- `Unauthorized: Ghost admin session required`

### 7.2 Transactional checks

Verify:

- magic link sign-in
- password reset
- staff invite email

### 7.3 Newsletter checks

Send a real Ghost test newsletter and verify:

- Ghost send returns quickly
- recipient receives email
- open event appears
- click event appears
- new rows appear in `batches`, `send_jobs`, and `recipient_emails`

### 7.4 Bridge checks

Useful commands:

```bash
docker compose ps
docker logs --tail 100 ghost-mail-bridge
curl http://localhost:3003/health
```

Useful DB check after a Ghost test send:

```bash
docker exec ghost-mail-bridge-mysql-1 mysql -ughost_mail_bridge -pghost_mail_bridge ghost_mail_bridge -e "
SELECT id, batch_message_id, status, total_recipients, queued_recipients, processing_recipients, sent_recipients, failed_recipients, last_error, created_at
FROM batches
ORDER BY created_at DESC
LIMIT 5;

SELECT id, batch_id, status, total_recipients, sent_recipients, failed_recipients, attempt_count, last_error, updated_at
FROM send_jobs
ORDER BY updated_at DESC
LIMIT 5;

SELECT recipient, batch_message_id, created_at
FROM recipient_emails
ORDER BY created_at DESC
LIMIT 5;
"
```

If the service name is Docker-generated, use:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

## 8. Common Failure Mode

Symptom:

- Ghost hangs for about 60 seconds and then errors with timeout

Most likely causes:

- Ghost is still pointed at an old stored `mailgun_base_url`
- Ghost cannot reach `ghost-mail-bridge:3003` on the Docker network
- bridge port was locked down but Ghost was still using a public host URL
- bridge IAM user can send on the SES identity but not on the SES configuration set

Symptom of the IAM/configuration-set problem:

- immediate send failures recorded by the bridge
- SES error mentioning not authorized for the configuration set resource

Fix:

- confirm Ghost env uses `http://ghost-mail-bridge:3003/v3`
- run `bash scripts/sync-ghost-mailgun-settings.sh`
- restart Ghost
- confirm `SES_CONFIGURATION_SET` matches the real SES configuration set name
- confirm bridge IAM policy covers both the sending identity and the configuration set

## 9. What We Should Turn Into Public Docs Later

- friendlier AWS screenshots/sequence
- exact IAM policy example
- exact SNS -> SQS policy example
- exact Docker network example with Ghost + bridge + proxy
- migration troubleshooting section
