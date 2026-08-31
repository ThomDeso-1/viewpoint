# Viewpoint Receipts

Photograph business receipts, extract vendor/date/total via Claude vision,
review and correct the extraction, and upload the expense to Wave
accounting. Self-hosted, single-user, installable as a PWA on iPhone.

- **Just want to run it?** → [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)
  (macOS `.pkg` installer + Tailscale, non-technical, ~15 minutes).
- **Deploying somewhere reachable from your phone, with HTTPS?** →
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
- **Auth model, and what to harden before this stops being single-user?** →
  [`docs/SECURITY.md`](docs/SECURITY.md).
- **Working on the code?** → [`AGENTS.md`](AGENTS.md) (rules, upgrade
  processes) and [`INDEX.md`](INDEX.md) (repo map). Known issues:
  [`docs/AUDIT.md`](docs/AUDIT.md).
- **Architecture / design background?** →
  [`docs/history/conversion-plan.md`](docs/history/conversion-plan.md) and
  [`docs/history/upgrade-plan.md`](docs/history/upgrade-plan.md).

## Local development

```bash
npm install && (cd client && npm install)
cp .env.example .env   # fill in what you have; the app can also write these via Settings
npm run dev             # server on :3000, client (Vite) on :5173 with API proxy
```

```bash
npm test                 # server tests (vitest + supertest)
(cd client && npm test)  # client tests (vitest + testing-library)
```

## Stack

React + TypeScript (Vite, PWA) · Node.js + Express + TypeScript ·
SQLite (`better-sqlite3`) · Claude API (extraction) · Wave GraphQL API
(expense upload).
