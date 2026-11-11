# Chalkboard — An Enterprise-Grade STEM Lecture Platform

**CMPE-272 (Enterprise Software Platforms), Section 49 — Team "Give us Internships"**
Bernie Miao · Pranith Varma Pakalapati · Sai Swaroop Dindi · Weihao Fu

Chalkboard turns STEM lecture videos into accessible, searchable learning resources. Standard captions omit the mathematics an instructor writes silently on the board; Chalkboard recovers it. A user submits a YouTube lecture URL and the platform produces a lecture page with a topic map, a transcript synchronized to the video, equations rendered as typeset math, and generated study notes.

## What it does

- **Lecture intake** — submit a YouTube URL; the job is queued and processed asynchronously, so the browser never waits on the pipeline.
- **Topic detection** — captions are analyzed to find topic boundaries and establish lecture context.
- **Structured extraction** — a Python worker uses the Gemini API to extract spoken explanations and mathematical content per section, with schema validation and self-healing retries.
- **Synchronized viewing** — generated sentences are aligned to the original caption timing (word-level alignment), equations are rendered with KaTeX, and clicking a sentence seeks the video.
- **Study notes** — per-topic notes are generated from the extracted content, with citations back to the lecture.
- **Platform operations** — persistent job queue with worker heartbeats, stale-job recovery, health checks, structured output validation, and Slack failure notifications.

## Architecture

| Component | Stack | Role |
|---|---|---|
| `viewer/` | Next.js, TypeScript, React, KaTeX | Web app: submission UI, job status, lecture viewer, notes |
| `pipeline/` | Python, SQLAlchemy, Alembic (15 migrations) | Worker: caption fetch (yt-dlp), Gemini extraction, alignment, notes |
| Database | PostgreSQL | Job queue (claims via `FOR UPDATE SKIP LOCKED`) and processing records |
| Infra | Docker (`Dockerfile.web`, `Dockerfile.worker`, `docker-compose.yml`, `docker-compose.railway.yml`) | Local and Railway deployment |

The worker polls the Postgres-backed queue independently of browser sessions, posts a heartbeat every 60 seconds while processing, and jobs whose heartbeat is stale for more than 5 minutes are recovered automatically. A `/api/health` endpoint reports service and queue status.

## Quick start

Prerequisites: Docker, and a Gemini API key.

```bash
cp .env.example .env        # fill in GEMINI_API_KEY and database settings
docker compose -f docker-compose.railway.yml up --build
```

The full-stack compose file brings up PostgreSQL, runs migrations, and starts the `web` and `worker` services; the worker begins polling the job queue on start. (The root `docker-compose.yml` starts only the database, for local development.) For local development without Docker, see `viewer/README.md` and `pipeline/` — the viewer is a standard Next.js app (`npm install`, `npm run dev`) and the worker runs as `python pipeline/scripts/worker.py` against any reachable PostgreSQL.

## Testing

- **Viewer unit tests** — 67 passed, 0 failed, 1 skipped (`npm test` in `viewer/`); TypeScript typecheck clean.
- **Pipeline tests** — **283 passed, 0 failed** (`pytest` in `pipeline/`), including the 59 database-backed tests run against PostgreSQL.
- **Accessibility** — a Playwright a11y suite lives with the viewer tests.

## Repository layout

```
viewer/     Next.js web application
pipeline/   Python processing worker (src/, scripts/, tests/)
dataset/    Sample and evaluation data
eval/       MathSpeech evaluation harness
docs/       Design and project documentation (see design_doc.md, CLAUDE.md)
```

## Notes

Chalkboard builds on an existing implementation developed by Bernie Miao (Mar–Sep 2026), adopted as the team baseline with the instructor's approval for previously developed projects. See `design_doc.md` for the full design and `CLAUDE.md` for the detailed engineering notes.
