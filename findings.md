# Security Findings

Date: 2026-03-02
Branch: dev
Status: implemented in working tree

## 1) Lock Ghost session verification to fixed domain

Risk:
- When `GHOST_ADMIN_URL` is not set, dashboard auth builds Ghost Admin URL from request host headers.
- In some deployments this can be abused.

Fix:
- Set these env vars explicitly:

```env
GHOST_ADMIN_URL=https://yourdomain.com
GHOST_ACCEPT_VERSION=v6.0
```

Reference:
- `lib/admin-dashboard.js` (`buildGhostBaseUrl`, `verifyGhostSession`)

## 2) Remove admin API key auth mode

Risk:
- Admin token auth creates an alternate control plane and key-management burden.

Fix:
- Remove `ADMIN_API_KEY` auth path entirely.
- Enforce Ghost session verification mode only (`GHOST_ADMIN_URL` + cookie verification).

Reference:
- `lib/admin-dashboard.js` (`createAdminAuthMiddleware`)

## 3) Keep bridge port private

Risk:
- Public bind (`3003:3003`) exposes bridge directly.

Fix:
- Bind localhost only in compose:

```yml
ports:
  - "127.0.0.1:3003:3003"
```

Reference:
- `docker-compose.example.yml`

## Operational policy decision

- Preferred mode for this project: Ghost admin session auth (cookie) only.
- Admin API key mode is intentionally not supported.
