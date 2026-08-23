# Viewpoint Receipts

Photograph business receipts, extract vendor/date/total via Claude vision,
review and correct the extraction, and upload the expense to Wave
accounting. Self-hosted, single-user, installable as a PWA on iPhone.

- **Just want to run it?** → [`GETTING-STARTED.md`](GETTING-STARTED.md)
  (Docker, non-technical, ~15 minutes).
- **Deploying somewhere reachable from your phone, with HTTPS?** →
  [`DEPLOYMENT.md`](DEPLOYMENT.md).
- **Auth model, and what to harden before this stops being single-user?** →
  [`SECURITY.md`](SECURITY.md).
- **Architecture / design background?** →
  [`CONVERSION-PLAN.md`](CONVERSION-PLAN.md).

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
