# Chalkboard

STEM lecture captioning platform. YouTube lecture URL → accessible web page with synced transcript where equations render as inline LaTeX via KaTeX.

**Mission:** Make the student get the experience most similar to a regular student. A regular student sees every line on the board and hears every word. Chalkboard provides both for students who can't see, can't hear, or both.

## Architecture (v2 — topic-aware pipeline)

The pipeline has evolved significantly from the original two-pass design. The current v2 pipeline:

```
YouTube URL
    │
    ├──→ yt-dlp: download auto-captions (.srt) + get duration
    │
    ├──→ Topic Map: text-only Gemini call on YouTube captions
    │    → produces section boundaries (3-10 min each) + lecture summary
    │    → ~$0.01 per lecture
    │
    ├──→ For each topic section (IN PARALLEL):
    │    │
    │    ├──→ Transcript chunk: Gemini video call, structured JSON output
    │    │    → sentences with inline LaTeX, NO timestamps
    │    │    → each chunk gets lecture context (summary + section info)
    │    │
    │    └──→ Equation chunk: Gemini video call, structured JSON output
    │         → equations with LaTeX, descriptions, timestamps
    │         → exhaustive: every line on the board being actively discussed
    │         → each chunk gets lecture context
    │
    ├──→ Word Alignment: SequenceMatcher aligns Gemini sentences
    │    against YouTube caption word stream
    │    → each sentence inherits accurate YouTube timestamps
    │    → sentences with same timestamp get merged
    │
    └──→ Output: demo JSON with segments, equations, sections, autoCaptions
```

### Why this architecture

- **Chunking by topic** (not arbitrary 10-min blocks): no mid-equation cuts, full context per topic, semantically meaningful boundaries
- **YouTube captions as the clock**: Gemini's timestamps drift 5-30s on long videos. YouTube's are sub-second accurate. Word-level alignment gives us Gemini's content with YouTube's timing.
- **No Gemini timestamps in transcript**: we told Gemini to stop producing timestamps (they were unreliable) and use structured JSON output instead (prevents thinking leaks)
- **Parallel processing**: transcript and equation chunks for all sections run concurrently (ThreadPoolExecutor, max 5 workers)
- **Lecture context in each chunk**: each API call gets the lecture summary + current/prev/next section titles, helping Gemini disambiguate symbols and use correct notation

### Model: `gemini-3.7-flash`

The live pipeline default is centralized in `pipeline/src/config.py`. Full processing, topic mapping, worker dispatch, and section reprocessing inherit it unless a run supplies an explicit model override. Evaluation harnesses and archived experiments keep their own pinned models.

### Known limitations

- **Equation timestamps are raw Gemini output** — NOT word-aligned like transcripts. Will drift. Fix: align equation timestamps against the transcript (future work).
- **Background equations extracted** — Gemini sometimes extracts equations that are merely visible on the board from earlier, not being actively discussed. Fix: update prompt to emphasize "actively discussed only" (in progress).
- **91-97% transcript word coverage** — even with chunking, Gemini drops ~3-9% of spoken content. Mostly filler words and fast speech. Acceptable for now.
- **Non-deterministic equation counts** — same video, same prompt, different runs produce different counts (107 vs 161). Structural LLM limitation.
- **Trailing dollar sign bug** — Gemini occasionally outputs malformed LaTeX delimiters (`$4x^3$$`). Fixed in `latex_fix.py` with orphaned dollar detection.

## Project structure

```
chalkboard/
├── pipeline/                          # Python 3.12 — Gemini extraction, processing
│   ├── pyproject.toml
│   ├── alembic/                       # DB migrations (Postgres)
│   ├── src/
│   │   ├── models/                    # SQLAlchemy 2.0 models
│   │   ├── extraction/
│   │   │   ├── gemini.py              # Gemini API calls (old pipeline, still used by process_video.py)
│   │   │   ├── topic_map.py           # Topic boundary detection from YouTube captions
│   │   │   ├── schemas.py             # Pydantic models: SentenceListOutput, EquationExtractionOutput
│   │   │   ├── prompts.py             # System/user prompts (transcript v0.3, equations v0.2)
│   │   │   └── latex_fix.py           # Fix JSON escape collisions + orphaned dollar signs
│   │   └── processing/
│   │       ├── word_align.py          # Word-level SequenceMatcher alignment against YouTube
│   │       ├── align.py               # Older ngram alignment (superseded by word_align)
│   │       └── merge.py               # Timestamp overlap merge + sanity checks
│   └── scripts/
│       ├── process_video.py           # v1 pipeline (DB-backed, old approach)
│       ├── process_video_v2.py        # v2 pipeline (topic-aware, demo JSON output)
│       └── export_demo_data.py        # Export DB data to demo JSON
├── eval/                              # Evaluation harness
│   ├── run_eval.py                    # MathSpeech benchmark (containment matching)
│   ├── drift.py                       # Timestamp drift measurement
│   ├── normalize.py                   # LaTeX normalizer for comparison
│   ├── match.py                       # Containment + fuzzy matching
│   ├── report.py                      # Summary reporting
│   ├── TRACKING.md                    # Evaluation tracking doc
│   └── extractions/                   # Pre-extracted equation JSONs for eval
├── dataset/                           # MathSpeech dataset + research
│   ├── mathspeech_by_video.json       # 89 videos, 1101 equations
│   └── datasetResearch.md             # Survey of 30+ related datasets
├── viewer/                            # Next.js 15 + TypeScript
│   ├── app/
│   │   ├── (marketing)/page.tsx       # Landing page at /
│   │   ├── (app)/dashboard/page.tsx   # Internal tool at /dashboard
│   │   └── (app)/video/[id]/page.tsx  # Video viewer
│   ├── components/
│   │   ├── VideoViewer.tsx            # Main viewer (player + equations + transcript)
│   │   ├── YouTubePlayer.tsx          # YouTube iframe API (always-on polling, startAt support)
│   │   ├── Transcript.tsx             # Single-highlight transcript, 1/3 scroll position
│   │   ├── GroupedEquations.tsx        # Topic-grouped equation panel with collapsible sections
│   │   ├── ActiveEquations.tsx        # Flat equation list (fallback when no sections)
│   │   └── landing/                   # Landing page components
│   │       ├── DemoViewer.tsx         # Interactive demo with auto-captions comparison
│   │       ├── TransformDiagram.tsx   # Before/after cards (speech→LaTeX, silence→equation, Feynman)
│   │       ├── ValueProps.tsx         # 9-bullet feature grid
│   │       ├── HowItThinks.tsx        # "It listens, it watches, it infers"
│   │       ├── FAQ.tsx                # WCAG compliance FAQ
│   │       └── ...                    # Hero, Explainer, Competitive, etc.
│   └── public/demo/                   # Static demo JSON files (no DB needed)
├── docker-compose.yml                 # Postgres 16
├── docs/decisions.md                  # Architecture Decision Records (13+ ADRs)
└── cowork/                            # Outreach/sales (gitignored)
```

## Pipeline scripts

- **`process_video_v2.py`** — the current pipeline. Topic-aware, parallel, word-aligned. Outputs demo JSON to `viewer/public/demo/`. Use this.
- **`process_video.py`** — the v1 pipeline. DB-backed, old chunking approach. Still works for the internal tool at `/dashboard` but not recommended for new processing.
- **`export_demo_data.py`** — exports DB records to demo JSON format.

## Key technical details

### Word alignment (`word_align.py`)
- Parses YouTube SRT into flat `(timestamp, word)` stream
- Strips LaTeX from Gemini sentences to get plain words
- Uses Python's `SequenceMatcher` (diff algorithm) to align word streams
- Each Gemini sentence inherits start/end timestamps from its matched YouTube word range
- Sentences with identical timestamps get merged
- Unmatched sentences get interpolated timestamps from neighbors
- Typical results: 96-99% of sentences matched, 96%+ of words aligned

### Topic map (`topic_map.py`)
- Text-only Gemini call (no video tokens — costs < $0.01)
- Input: YouTube auto-caption text with timestamps
- Output: section boundaries with titles, descriptions, lecture summary
- Guard: sections >12 minutes auto-split at midpoint
- Produces context prompts for each chunk (lecture summary + prev/next section)

### Structured output
- Transcript uses `SentenceListOutput` schema (just `{"sentences": [{"text": "..."}]}`)
- Equations use `EquationExtractionOutput` schema (LaTeX, description, timestamps, confidence)
- Structured output prevents Gemini from leaking chain-of-thought or adding unwanted formatting

### LaTeX fixes (`latex_fix.py`)
- JSON escape collision: `\f`→formfeed, `\t`→tab, `\b`→backspace eat LaTeX commands
- Detects control characters inside `$...$` blocks and restores backslash+letter
- Fixes orphaned dollar signs (odd count → remove last unpaired `$`)
- Collapses double dollar signs (`$$` → `$`)

## Coding conventions

- **Python:** Python 3.12, `google-genai` SDK, `gemini-3.7-flash` production default
- **TypeScript:** Next.js 15 app router, Tailwind CSS, KaTeX
- **Gemini calls:** 0.5 FPS, default resolution, structured JSON output, `response.parsed` for deserialization
- **Theming:** CSS variables (`--foreground`, `--background`, `--muted`, `--card`, etc.), `.dark` class toggle
- **LaTeX:** `$...$` delimited. Always run through `fix_latex_escapes()` before storing/displaying.
- **Transcript highlighting:** single active segment (last segment whose start ≤ currentTime), scroll to 1/3 position
- **Equation highlighting:** `currentTime >= start && currentTime <= end`, auto-scroll active equation

## Deployment

- **Landing page:** Vercel at `chalkboard.video` (static, no DB dependency)
- **Railway (demo backend):** Two services — Next.js web + Python worker, communicating via Postgres queue
  - `Dockerfile.web` — Node 22 alpine, standalone Next.js, healthcheck on `/api/health`
  - `Dockerfile.worker` — Python 3.12-slim, ffmpeg, tini, yt-dlp, polls Postgres for queued runs
  - `docker-compose.railway.yml` — local integration testing (db + migrate + web + worker)
- **Demo data:** static JSON files in `viewer/public/demo/` — processed offline, committed to repo

## Operations

Railway exists for client demo URLs, not production polish. The pipeline needs heavy iteration (model changes, prompt tweaks, edge cases). Every deployment risks extending the debug loop. The goal: **know within seconds, understand within minutes, reproduce locally without guessing.**

### Debug loop

1. **Something fails** → Slack fires with traceback tail, run ID, source URL
2. **Queue goes silent** → Worker detects no completions in 30+ min with jobs waiting, fires Slack alert
3. **Investigate** → `python scripts/replay_run.py <run_id> --db-url $RAILWAY_DB_URL`
4. **Reproduce locally** → Copy-paste the replay command, attach debugger, iterate
5. **Fix and redeploy** → `python scripts/smoke_test.py --base-url <url> --password $PASS`

### Operational scripts

- **`pipeline/scripts/worker.py`** — Postgres-polled worker. `FOR UPDATE SKIP LOCKED`, heartbeat thread, stale run recovery, SIGTERM handling, queue-stuck Slack alert.
- **`pipeline/scripts/smoke_test.py`** — Post-deploy verification. Quick mode (~30s): env, connectivity, enqueue + verify worker claims. Full mode (~5min): wait for completion, assert counts.
- **`pipeline/scripts/replay_run.py`** — Reads failed run's params from DB, prints copy-pasteable local replay command. Handles R2 keys with download warning.
- **`pipeline/scripts/inspect_run.py`** — Read-only investigation helper for user-reported "this looks weird" complaints. Lists runs for a video, summarizes one run by content_type, dumps item metadata, diffs two runs. See `docs/investigating-outputs.md` for the full workflow (includes how to get `DATABASE_PUBLIC_URL` for laptop access to prod DB).

### Deployment flow (Railway)

**The only normal path to production is: open PR → merge to `main` → Railway's GitHub integration auto-builds + deploys.** Do not deploy any other way without a specific reason.

- **Never `railway up` from an unmerged branch.** `railway up` uploads the current working directory straight to production, ignoring branches, PRs, and review. This creates drift: `main` (the source of truth) no longer matches what's actually running, and the next `git push` to `main` silently overwrites whatever you uploaded. If you catch yourself reaching for `railway up` to "just test this quickly," stop — open a draft PR and use docker-compose locally instead.
- **Treat `railway up` like `git push --force`.** Legitimate uses are rare: emergency hotfix when CI is broken, deploying a branch intentionally for side-by-side testing (not this project's pattern), or bootstrapping a fresh service. Each of these needs a conscious "I am bypassing `main` because X" justification in the moment.
- **Reverting a bad deploy is painful — reflect that cost in whether to ship.** Railway prunes old deployment images to REMOVED state within minutes, so you cannot roll back by redeploying a prior deployment ID once it's aged out. The only reliable revert is a fresh build from `main`'s current state, which means either (a) pushing a new commit to `main` (empty commits don't always trigger a rebuild — push something real), or (b) `railway up` from a main-checked-out worktree. Both take 3-5 min of build time during which prod is still wrong.
- **Env vars set via `railway variables --set` persist across deploys.** If you add one during debugging, delete it with `railway variable delete --service <svc> <KEY>` when you're done, or it'll quietly keep affecting builds forever.

### Health & monitoring

- **`/api/health`** — `SELECT 1` with 3s timeout. Wired to Docker HEALTHCHECK.
- **Slack** — Every pipeline run (success + failure). Word coverage warnings (<90%), alerts (<80%). Worker queue-stuck alert (env: `WORKER_STUCK_ALERT_MINUTES`, default 30).
- **Heartbeat** — Worker updates `heartbeat_at` every 60s. Stale runs (no heartbeat for 5 min) auto-recovered on startup.

### Platform constraints

- **Worker requires a long-running container.** The Python worker cannot run on Vercel (function timeout), Cloudflare Workers (no persistent state), or any serverless-only platform. Jobs run 1-5 min; Gemini video + ffmpeg need persistent memory. Host it on Railway, Render, Fly, or Modal — never on a serverless edge platform. See ADR-018.
- **Keep Postgres portable.** Don't use Railway-specific Postgres extensions or features. Stick to standard SQL. First institutional customer will require migrating the DB to a FERPA-capable host (Neon, AWS RDS, Supabase). Portability hygiene starts now, not when the RFP lands.
- **Two deployment targets, intentionally.** `chalkboard.video` (marketing) → Vercel. App + worker + DB → Railway. Marketing uptime is decoupled from pipeline iteration. See ADR-018 for the consolidation trigger and migration path.
- **Backup strategy (TODO).** Nightly `pg_dump` to R2 for disaster recovery. Railway's managed Postgres had documented data-loss incidents in late 2025 and has no native PITR. Not yet implemented — tracked in ROADMAP.md under "Compliance & migration triggers."

## Future work (noted in docs/decisions.md)

- **Visual map pass** — low-res Gemini pass to identify which sections have visual math content vs speech-only. Powers: slide detection, diagram extraction, skip non-equation sections. Not built yet.
- **Equation timestamp alignment** — align equation timestamps against word-aligned transcript (like we do for transcript vs YouTube)
- **Self-serve demo** — live processing on the landing page (needs Railway/Fly backend)
- **Cross-panel highlighting** — hover equation → highlight linked transcript segment
- **Confidence-based re-runs** — re-extract low-confidence equations with targeted prompts
- **Study guide generation** — use topic map + equations to generate structured summaries
- **Gemini Live for CART** — real-time captioning (separate architecture)
- **Graph/chart alt-text** — describe graphs and charts as structured alt-text (not recreated visually, just described for screen readers)
- **Code snippet extraction** — extract code snippets from lectures in a screen-reader-friendly format
- **Table extraction** — extract tables from lectures in a screen-reader-friendly format
- **Slide extraction** — detect and extract slide content (text, diagrams, bullet points) for screen-reader-friendly presentation
- **Verification/recursive reprompting** — low-confidence segments get re-ingested by the 3.1 Pro reasoning model with multimodal assistance: Mathpix for LaTeX OCR, Chirp 3 for raw transcript, plus video + audio. Use cutting-edge specialized tools for each modality rather than relying on one model for everything. Test on nightmare scenarios: strong accents, low-quality video, blurry whiteboards
- **Audio descriptions** — synthesized narration that describes visual actions (writing, erasing, demonstrations, gestures) during gaps in speech. Analyze audio levels to find natural pauses, generate scene descriptions via Gemini video pass, then insert TTS audio descriptions that play in the gaps — like descriptive video service for lectures. Uses the `scene_description` content type in the visual content schema (already extensible for this)
- **Corporate accessibility training videos** — expand beyond STEM lectures into corporate training content. Same pipeline (visual content extraction, transcription, audio descriptions) applied to compliance training, onboarding videos, product demos. Different market (L&D / HR buyers), same compliance drivers (ADA, WCAG)
- **Testing/debug interface** — batch processing UI to run the full MathSpeech corpus (89 MIT lectures) through the pipeline. Shows per-video results, diffs between runs, confidence distributions, failure modes. Doubles as a debug interface for investigating extraction issues. Uses the existing eval harness (`eval/run_eval.py`) but with a web UI instead of CLI
- **Bounding boxes / spatial coordinates** — have Gemini mark WHERE on screen each equation or visual content appears. Could power: click-to-seek from a specific board region, spatial layout reconstruction, verification by showing the frame crop. Challenge: need a way to communicate coordinates without re-encoding the video with a grid overlay. Approach: send frame screenshots to Gemini and ask for normalized (x, y, width, height) coordinates. Requires better equation timestamping first (need to know which frame to screenshot)
- **Reportable moments** — dashboard feature that surfaces edge cases for institutions. Lets users flag specific timestamps where extraction looks wrong (low confidence, missing content, wrong classification). One-click reporting that captures the timestamp, frame, extracted content, and user note. Gives us an immediate dive-in point for debugging without the institution needing to explain what went wrong

## Nightmare scenario test cases

These are cases where the pipeline is expected to struggle. Each needs a real test video and documented results.

- **Fast speech with no board** — professor talking theory without writing. No visual anchor, Gemini is just a worse ASR at that point. Need to compare transcript quality against dedicated ASR (Chirp 3)
- **Heavy accents + blurry board** — both modalities degraded, so cross-referencing doesn't help. The verification pipeline (ADR-014) is designed for this
- **Overlapping speech** — student questions, multiple speakers. ASR with diarization handles this better. Gemini may jumble speakers
- **Numbers and data** — professor reads off a data table verbally. ASR might be more precise on raw numeric transcription
- **Non-English technical terms** — proper nouns, chemical names. Acoustic discrimination problems where a specialized ASR vocabulary might win
- **112-min Zoom recording** — long format, screen share, variable quality. Currently testing with L'Hopital's lecture (iw72Yj_pJGs). 3 Flash Preview: 63% word coverage (catastrophic). 2.5 Flash GA: ~90% coverage (acceptable). Gemini 500 errors observed on 3 Flash, zero on 2.5 Flash
- **Similar-looking letters in handwriting** — `h(z)` misread as `f(z)` (iw72Yj_pJGs at 1:35:35). Professor wrote silently, no speech to cross-reference. Pure visual discrimination failure. Gemini defaults to more common function names. Needs Mathpix second opinion or higher resolution

## Docs

- `docs/decisions.md` — 13+ Architecture Decision Records with rationale
- `docs/investigating-outputs.md` — "User says this output looks weird" workflow. How to tell a viewer bug from a pipeline bug, query the Railway DB from your laptop, and reprocess at full / section / visual-only granularity.
- `docs/known-issues.md` — Latent bugs and footguns to fix before scaling.
- `eval/TRACKING.md` — Evaluation tracking (processed videos, results, costs)
- `design_doc.md` — Original technical spec (partially outdated — this file is authoritative)
