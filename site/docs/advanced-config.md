---
title: Advanced Configuration
layout: docs
---

# Advanced configuration

Most users should keep the defaults. Only change these values when troubleshooting, load-testing, or running a specialized deployment.

For copy/paste examples, see [`.env.advanced.example` on GitHub](https://github.com/ifrederico/ghost-mail-bridge/blob/main/.env.advanced.example).

## Retry and backoff tuning

| Variable | Default | What it controls | When to change |
|----------|---------|------------------|----------------|
| `SES_SEND_MAX_RETRIES` | `3` | Retries per recipient when SES returns transient/throttling errors. | Increase for unstable AWS/network conditions; decrease for faster fail-fast behavior. |
| `SES_RETRY_BASE_MS` | `500` | Base backoff (milliseconds) before retry jitter is applied. | Increase to reduce pressure during throttling bursts. |
| `SES_RETRY_MAX_MS` | `10000` | Maximum backoff cap (milliseconds). | Increase if SES throttling persists and you want slower retry pacing. |

## Request safety limits

| Variable | Default | What it controls | When to change |
|----------|---------|------------------|----------------|
| `MAX_REQUEST_BYTES` | `10485760` | Maximum HTTP request body size accepted by the Mailgun-compatible send endpoint. | Increase only if you intentionally send larger payloads. |
| `MAX_FORM_FIELDS` | `2000` | Maximum multipart form fields allowed per request. | Increase only for unusual payload shapes. |
| `MAX_FIELD_SIZE_BYTES` | `2097152` | Maximum size for a single multipart field value. | Increase only if a known field legitimately exceeds 2MB. |
| `MAX_RECIPIENTS` | `50000` | Maximum recipients allowed in one send request. | Lower to enforce stricter operational guardrails. |
| `MAX_CUSTOM_HEADERS` | `100` | Maximum number of `h:*` custom headers accepted per request. | Increase only if your integration needs more custom metadata. |

## Ghost Admin API compatibility

| Variable | Default | What it controls | When to change |
|----------|---------|------------------|----------------|
| `GHOST_ACCEPT_VERSION` | `v6.0` | `Accept-Version` header used when validating Ghost Admin sessions for dashboard auth. | Change only if your Ghost Admin API version policy requires a different value. |

## Local development and testing switches

| Variable | Default | What it controls | When to change |
|----------|---------|------------------|----------------|
| `DISABLE_SQS_POLLER` | `false` | Disables SQS polling loop. | Enable (`1`) for local dashboard styling/demo work without queue traffic. |
| `DISABLE_ADMIN_AUTH` | `false` | Skips Ghost session verification for dashboard routes. | Enable (`1`) only in local/dev environments. Never use in production. |

## Safe-default guidance

- Keep these defaults unless you have a specific operational issue to solve.
- Change one variable at a time and observe behavior before tuning further.
- Document any non-default values in your deployment config for future maintainers.
