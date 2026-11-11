# Chalkboard viewer (Next.js)

The web tier of Chalkboard: the marketing/landing page, the submission dashboard, the lecture viewer, and the study-notes page, plus the API routes they call. See the [root README](../README.md) for the full-stack quick start.

## Layout

```
app/(marketing)/page.tsx          Landing page (interactive demo built from public/demo/*.json)
app/(app)/dashboard/              Submission dashboard + run monitoring (password-protected)
app/(app)/video/[id]/             Lecture viewer: player, synchronized transcript, equations by topic
app/(app)/video/[id]/notes/       Study notes with citations and frame crops
app/(app)/api/                    18 route handlers: process, runs, cancel, upload, notes, health, auth, …
components/                       Viewer, transcript, equation panels, landing sections
lib/                              Data access (PostgreSQL), transforms, timing/sync logic + unit tests
tests/a11y/                       Playwright accessibility suite (axe + virtual screen reader)
public/demo/                      10 pre-processed lectures used by the landing-page demo
```

## Commands

```bash
npm ci
npm run dev          # http://localhost:3000 — needs DATABASE_URL, DASHBOARD_PASSWORD, AUTH_SECRET in ../.env
npm test             # unit tests (node:test via tsx)
npx tsc --noEmit     # typecheck
npm run test:a11y    # Playwright accessibility suite (starts its own dev server on :3001)
npm run build        # production build (standalone output, used by ../Dockerfile.web)
```

The landing page and its interactive demo work without a database. The dashboard, lecture and notes pages read from PostgreSQL, which the Python worker populates.
