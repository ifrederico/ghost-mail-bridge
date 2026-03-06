# Isolated install

This guide is for a host/systemd-style install where the bridge runs directly on the host.
If you're running the official Ghost Docker stack in `/opt/ghost` and want the bridge beside it in `/opt/ghost-mail-bridge`, follow the Docker sidecar flow in [README.md](../README.md).

This layout is designed to feel like a self-hosted Ghost install:

```text
/opt/ghost-mail-bridge/
  current/                 # app checkout
  config.env               # runtime environment
  logs/                    # optional log target
```

Recommended setup:

1. Clone or copy the repo into `/opt/ghost-mail-bridge/current`
2. Create `/opt/ghost-mail-bridge/config.env` from [`.env.example`](../.env.example)
3. Install production dependencies:

```bash
cd /opt/ghost-mail-bridge/current
npm ci --omit=dev
```

4. Install the systemd units from `deploy/systemd/`
5. Add the Caddy snippet from `deploy/caddy/Caddyfile.example`
6. In Ghost, set:

```bash
bulkEmail__mailgun__baseUrl=http://127.0.0.1:3003/v3
bulkEmail__mailgun__apiKey=your-secure-api-key-here
bulkEmail__mailgun__domain=example.com
```

Notes:

- Create a dedicated system user before enabling the units, for example:

```bash
sudo useradd --system --home /opt/ghost-mail-bridge --shell /usr/sbin/nologin ghost-mail-bridge
```

- The bridge is isolated from Ghost except for Ghost’s bulk-email `.env` values and the optional Caddy route for `/ghost/mail`.
- Keep MySQL dedicated to the bridge when possible.
- The API service name in Docker remains `ghost-mail-bridge`, but for host installs `127.0.0.1:3003` is the simplest Ghost target.
