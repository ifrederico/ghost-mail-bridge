# Roadmap

## Next

- Add a one-command install/update path for Ghost Docker sidecar installs.
- Expand automated coverage for queue retries, worker restarts, duplicate SES events, and DLQ handling.
- Tighten dashboard health and delivery metrics so newsletter-only data is always clear.

## Soon

- Add per-newsletter and per-post analytics using `ghost_email_id` and message mapping.
- Add filtered CSV export for the current dashboard view.
- Improve upgrade safety around Ghost Mailgun-setting sync and recovery.

## Later

- Add deeper queue and worker observability for production support.
- Validate the install flow across more server setups.
