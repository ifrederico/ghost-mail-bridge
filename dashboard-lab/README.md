# Dashboard Lab (Dev Branch)

This is a mock server + UI sandbox for styling the Ghost Mail Bridge dashboard with fake data.
It now uses a CSS extraction step:
- source styles: `dashboard-lab/styles/ghost-lab.source.css`
- generated styles used by UI: `dashboard-lab/public/styles.css`

## Run

```bash
npm run dashboard:lab
```

To rebuild CSS without starting the server:

```bash
npm run dashboard:lab:css
```

Open:

- `http://localhost:4173/ghost/email`

## Scenarios

Use the scenario selector in the UI:

- `Healthy traffic`
- `Low volume warm-up`
- `Incident mode`

No real SES, Ghost, SQS, or database calls are made by this lab.
