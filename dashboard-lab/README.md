# Dashboard Lab (Dev Branch)

This is a mock server + UI sandbox for styling the Ghost Mail Bridge dashboard with fake data.

## Run

```bash
npm run dashboard:lab
```

Open:

- `http://localhost:4173/ghost/email`

## Scenarios

Use the scenario selector in the UI:

- `Healthy traffic`
- `Low volume warm-up`
- `Incident mode`

No real SES, Ghost, SQS, or database calls are made by this lab.
