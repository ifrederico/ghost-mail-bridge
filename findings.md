# Security Findings (Deferred Fixes)

Date: 2026-03-02
Branch: dev
Status: documented for later implementation

## 1) Lock Ghost session verification to fixed domain

Risk:
- When `GHOST_ADMIN_URL` is not set, dashboard auth builds Ghost Admin URL from request host headers.
- In some deployments this can be abused.

Fix:
- Set these env vars explicitly:

```env
GHOST_ADMIN_URL=https://fred.pt
GHOST_ACCEPT_VERSION=v6.0
```

Reference:
- `lib/admin-dashboard.js` (`buildGhostBaseUrl`, `verifyGhostSession`)

## 2) Stop accepting admin API key in URL query

Risk:
- `?apiKey=...` can leak through logs/history/referrer.

Fix:
- Only accept header auth (`x-admin-api-key`), remove query fallback.

Current line pattern:

```js
var providedApiKey = req.headers['x-admin-api-key'] || req.query.apiKey || '';
```

Target:

```js
var providedApiKey = req.headers['x-admin-api-key'] || '';
```

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
- Keep `ADMIN_API_KEY` unset unless machine-to-machine access is explicitly needed.

