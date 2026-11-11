# Chalkboard — An Enterprise-Grade STEM Lecture Platform

**CMPE-272 (Enterprise Software Platforms), Section 49 — Team "Give us Internships"**
Bernie Miao · Pranith Varma Pakalapati · Sai Swaroop Dindi · Weihao (Wayne) Fu

Chalkboard turns STEM lecture videos into accessible, searchable learning resources. Standard captions omit the mathematics an instructor writes silently on the board; Chalkboard recovers it. A user submits a YouTube lecture URL and the platform produces a lecture page with topic sections, a transcript synchronized to the video, equations rendered as typeset math, and generated study notes.

**Live deployment:** <https://chalkboard.video> (landing page with an interactive demo of real processed lectures). Processed lecture pages at `https://app.chalkboard.video/video/<id>` are public; the submission dashboard is password-protected.

## What it does

- **Lecture intake** — submit a YouTube URL; the job is queued and processed asynchronously, so the browser never waits on the pipeline.
- **Topic detection** — captions are analyzed to find topic boundaries and establish lecture context.
- **Structured extraction** — a Python worker uses the Gemini API to extract spoken explanations and mathematical content per section, with schema validation and self-repair of malformed output.
- **Synchronized viewing** — generated sentences are aligned to the original caption timing (word-level alignment), equations are rendered with KaTeX (with MathML for screen readers), and clicking a sentence seeks the video.
- **Study notes** — per-topic notes with citations back to the lecture and frame crops from the video.
- **Platform operations** — persistent job queue with worker heartbeats, stale-job recovery, a health endpoint, structured output validation, and Slack failure notifications.

## Architecture

| Component | Stack | Role |
|---|---|---|
| `viewer/` | Next.js 16, TypeScript, React, KaTeX | Web app: submission dashboard, run status, lecture viewer, notes; 18 API routes |
| `pipeline/` | Python 3.12, SQLAlchemy 2.0, Alembic (14 migrations) | Worker: caption fetch (yt-dlp), Gemini extraction, alignment, validation, notes |
| Database | PostgreSQL | Job queue (claims via `FOR UPDATE SKIP LOCKED`) and system of record |
| Infra | Docker (`Dockerfile.web`, `Dockerfile.worker`, two compose files), Railway + Vercel | Local full stack and production deployment |

The worker polls the Postgres-backed queue independently of browser sessions and writes a heartbeat every 60 seconds while processing; runs whose heartbeat has been silent for more than 5 minutes are detected as stale and recovered. `GET /api/health` checks database connectivity and backs the container health check.

## Quick start (full stack in Docker)

Prerequisites: Docker Desktop and a [Gemini API key](https://ai.google.dev/). Ports 5432 and 3000 must be free — stop any local PostgreSQL first, or the `db` container cannot bind 5432.

```bash
cp .env.example .env
```

Edit `.env` and set the three required values:

| Variable | What to put |
|---|---|
| `GEMINI_API_KEY` | your Gemini API key (used by the worker) |
| `DASHBOARD_PASSWORD` | any password — this is what you type on the dashboard login page |
| `AUTH_SECRET` | a random string: `python3 -c "import secrets; print(secrets.token_hex(32))"` |

`DATABASE_URL` in `.env` is only for running the services outside Docker; the compose file wires the containers to its own database.

```bash
docker compose -f docker-compose.railway.yml up --build
```

This starts PostgreSQL, runs the Alembic migrations, then starts `web` (http://localhost:3000) and `worker`. Open http://localhost:3000/dashboard, log in with your `DASHBOARD_PASSWORD`, paste a YouTube lecture URL, and watch the run progress. A short lecture (~10 min) takes a few minutes to process.

The root `docker-compose.yml` starts **only** the database — use it for local development and for the pipeline tests.

## Running the tests

Both compose files create a separate `chalkboard_test` database on first start (`scripts/db/init-test-db.sql`). If your `pgdata` volume predates this, either run `docker compose down -v` once, or create it by hand:
`docker compose exec db psql -U chalkboard -c "CREATE DATABASE chalkboard_test;"`

**Pipeline (Python)** — requires Python 3.12+:

```bash
docker compose up -d db                 # database only
cd pipeline
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/
```

Expected: **283 passed** (224 unit tests + 59 tests that run against the `chalkboard_test` database). Without a reachable test database the 59 DB-backed tests error out; the other 224 still pass.

**Viewer (TypeScript)** — requires Node 20+:

```bash
cd viewer
npm ci
npm test                 # 68 tests: 67 pass, 1 skipped
npx tsc --noEmit         # typecheck
```

**Accessibility** — `npm run test:a11y` runs the 10-test Playwright suite (axe checks + virtual screen reader) in `viewer/tests/a11y/`; it starts its own dev server on port 3001 (first run: `npx playwright install chromium`).

Or run everything with `scripts/run-all-tests.sh` (logs land in `docs/testing/logs/`). Captured runs with screenshots: [`docs/testing/`](docs/testing/).

## Local development without Docker (optional)

Needs PostgreSQL, Python 3.12+, Node 20+, plus `ffmpeg` and [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on `PATH` (`brew install ffmpeg yt-dlp deno` on macOS — yt-dlp uses deno for YouTube's JS challenges).

```bash
docker compose up -d db                       # or any PostgreSQL; set DATABASE_URL in .env
cd pipeline && pip install -e ".[dev]" && alembic upgrade head
python scripts/worker.py                      # start the worker (reads ../.env)
cd ../viewer && npm ci && npm run dev         # web app on http://localhost:3000
```

## Repository layout

```
viewer/       Next.js web application (app/, components/, lib/, tests/a11y/)
pipeline/     Python worker: src/ (extraction, alignment, models), scripts/, tests/, alembic/
eval/         MathSpeech evaluation harness and tracking
dataset/      MathSpeech benchmark metadata (89 videos, 1,101 equations)
scripts/      Operational scripts (DB init, maintenance)
docs/         Decisions log (ADRs), known issues, roadmap, testing evidence, design history
design_doc.md Original technical specification
CLAUDE.md     Engineering notes: current architecture, debug loop, platform constraints
              (also used as context for AI coding assistants)
```

## Team contributions

| Member | Role |
|---|---|
| Bernie Miao | Software development — the Chalkboard codebase (viewer, pipeline, infrastructure) |
| Sai Swaroop Dindi | LLM implementation |
| Weihao (Wayne) Fu | Outreach and write-up |
| Pranith Varma Pakalapati | Presentation and slides |

Chalkboard builds on an implementation Bernie Miao developed from March to September 2026, adopted as the team baseline with the instructor's approval for previously developed projects. This repository is a snapshot of that codebase prepared for the course; see `docs/decisions.md` for the architecture decision records and `design_doc.md` for the original design.
