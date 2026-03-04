# Ghost Mail Bridge Roadmap

Last updated: 2026-03-04

## V1 (Current)

- Dashboard served at `/ghost/mail`
- Account-level analytics with real period windows (`7d`, `30d`, `90d`, `ytd`, `12m`, `all`)
- Real timeline API for delivery metrics (sent, delivered, opened, clicked, failed, complained)
- Unique opens/clicks logic in dashboard metrics
- Health page + integration checks
- Human-readable failure reason summaries

## V2 (Planned)

- Per-newsletter/post analytics mode (match Ghost post analytics view)
- Filter by newsletter send (`ghost_email_id` / message mapping)
- Post-level cards: Sent, Opened, Clicked
- Post-level chart + timeline table
- Link-level click breakdown for selected post
- Toggle between account aggregate and post-specific views

## V3 (Planned)

- CSV export for current filters (period + optional post)
- Saved dashboard views (default period/tab/filter)
- Better alerting thresholds (failure/complaint/suppression) in settings
- Optional webhook/Slack notifications for alert states

## Ops and Reliability

- Response caching for heavy dashboard queries
- Backfill/rebuild tooling for analytics timeline
- Performance profiling for long-window queries

## Security and Hardening

- Full dependency + app-level security audit pass
- Stricter input validation and error handling on admin APIs
- Rate limiting for admin API endpoints
