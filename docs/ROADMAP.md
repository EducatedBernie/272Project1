# Chalkboard Roadmap

Operational tracking doc. What we're working on, what blocks what, what's planned next.

For *why* we made past decisions, see [decisions.md](./decisions.md).
For current architecture, see [../CLAUDE.md](../CLAUDE.md).
For the original product spec (archived), see [archive/design_doc_v1.md](./archive/design_doc_v1.md).

---

## Status legend

- 🔴 **Blocker** — must ship before the next milestone
- 🟡 **Should-have** — production risk if skipped, but not strictly blocking
- 🟢 **Nice-to-have** — quality of life, parking lot
- ✅ **Done** — recent context (kept brief, pruned over time)

---

## Current focus

**Milestone:** Railway deployment for asynchronous client demos.

**Status:** All 7 blockers shipped. Reliability layer (smoke test, replay helper, queue-stuck alert, health endpoint) complete. Ready to deploy.

**Why this milestone:** Clients need to access processed videos without us being in the loop. Vercel hosts the static landing page (`chalkboard.video`), but the dashboard, upload, and pipeline need a real backend.

---

## ✅ Pre-Railway blockers (all shipped)

### 1. Worker architecture
**Status:** ✅ Done
**Why blocker:** Current design spawns Python child processes from Next.js (`spawn(...)` in `/api/upload` and `/api/reprocess`). On Railway:
- Long-running pipelines (30+ min for big videos) outlive request handlers
- Subprocess gets killed by memory limits or restarts
- No recovery mid-run

**Decision needed:** Two-service split.
- **Web service:** Next.js handles UI + API, inserts `pipeline_runs` rows with `status='queued'`
- **Worker service:** Python long-running process, polls or `LISTEN/NOTIFY` on Postgres for new queued runs, executes pipeline

**Impact:** Touches every spawn site. Removes the `spawn()` calls from upload/reprocess routes. Adds a worker entrypoint script.

---

### 2. R2 storage (Phase 5 from original plan)
**Status:** ✅ Done
**Why blocker:** `pipeline/uploads/` doesn't persist on Railway, and isn't web-accessible for the HTML5 player even if it did.

**Required:**
- Cloudflare R2 bucket created (`chalkboard-media`)
- Custom domain bound (e.g., `media.chalkboard.video`)
- Browser upload flow: presigned URL OR proxy through Next.js (proxy is simpler for v1)
- Worker downloads from R2 for ffmpeg audio extraction + Gemini File API upload
- HTML5 player URL becomes the R2 public URL

**Depends on:** Worker architecture (so the worker knows how to fetch from R2)

---

### 3. DB schema for uploads (Phase 6 from original plan)
**Status:** ✅ Done
**Why blocker:** Today the `videos.youtube_url` column holds local file paths for uploaded videos. This is hacky and won't survive a redeploy.

**Required columns on `videos`:**
- `source_type` enum: `'youtube' | 'upload'`
- `r2_key` (R2 object key, e.g., `videos/<uuid>/lecture.mp4`)
- `r2_url` (full public URL for playback)

**Migration:** Backfill existing rows. YouTube videos get `source_type='youtube'`, uploaded videos with local paths get migrated to R2 first or marked as orphaned.

**Touches:** Video model, video page query (`page.tsx` already checks `r2_url` first), debug page, upload route, dashboard query

---

### 4. Authentication on /dashboard
**Status:** ✅ Done
**Why blocker:** Anyone with the URL can upload and burn through Gemini + Chirp 2 budget. No protection against abuse.

**Implemented:** HMAC cookie auth via Next.js middleware. Login at `/login`, shared password via `DASHBOARD_PASSWORD` env var. Cookie stores HMAC (never the plaintext password). Fail-closed — missing `DASHBOARD_PASSWORD` blocks access. Open redirect protection on login redirect. Constant-time comparison on both login route and middleware.

**Railway deploy checklist:**
- `DASHBOARD_PASSWORD` — strong random password
- `AUTH_SECRET` — `openssl rand -hex 32`. **Do not rely on the source code fallback** — it's public on GitHub, which means anyone who reads the repo can forge cookies if they also crack the password. Set a real random secret.

**Not yet implemented (acceptable for MVP):**
- Rate limiting on `/api/auth/login` (needs Redis/KV, add when brute-force becomes a real concern)
- Logout endpoint (low priority for shared-password auth)
- Per-user accounts (switch to NextAuth when clients need their own logins)

---

### 5. Slack webhook alerting (ADR-016)
**Status:** ✅ Done
**Why blocker:** Already documented as prerequisite in [ADR-016](./decisions.md#adr-016-pipeline-observability--slack-webhook-alerting-for-production). Without it, production failures are invisible until a client reports them.

**Required:**
- One env var: `CHALKBOARD_SLACK_WEBHOOK`
- `notify_pipeline_event()` function in `process_video_v2.py`
- Called from both success and except branches
- Includes: title, source, stage, error summary, run ID, link to debug page, word coverage %
- Quality flag: warn if word coverage < 90%, alert if < 80%

**User action required:** Create Slack app, generate webhook URL, paste it back

---

### 6. GCP service account key handling
**Status:** ✅ Done
**Why blocker:** `chalkboard-stt-key.json` (Chirp 2 credentials) cannot be committed. Railway needs to provide it at runtime.

**Standard pattern:**
1. Base64-encode the JSON key locally
2. Set as Railway env var: `GOOGLE_APPLICATION_CREDENTIALS_JSON`
3. On worker startup, decode to `/tmp/gcp-key.json`
4. Set `GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json` env var

---

### 7. Dockerfile(s)
**Status:** ✅ Done
**Why blocker:** Railway needs custom images. The worker needs `ffmpeg`, Python 3.12, all pip deps, and the pipeline source. The web service needs Node + Next.js.

**Two Dockerfiles:**
- `Dockerfile.web` — Node 20, Next.js build
- `Dockerfile.worker` — Python 3.12, ffmpeg, alembic migrations on entry, worker poll loop

---

## 🟡 Should-have (production risks, not strict blockers)

### File cleanup policy
**Why:** R2 storage costs accumulate forever otherwise. Local `pipeline/uploads/` has the same issue.
**Approach:** Cron job or scheduled task to delete files older than N days where the corresponding video is `complete` or `failed`. Probably 30-day retention for completed videos, 7 days for failed.

### Idempotent runs
**Why:** If a worker crashes mid-pipeline, we get partial data in the DB. Reprocessing doesn't clean it up.
**Approach:** Wrap each run's DB writes in a transaction, or mark runs as `crashed` (separate from `failed`) and allow safe re-runs that delete prior partial data first.

### Migration on deploy
**Why:** Schema changes need to apply before code that depends on them runs.
**Approach:** Railway release command: `alembic upgrade head` runs before the worker entrypoint.

### Reprocess for uploads (in-progress, uncommitted)
**Status:** Code written, untested
**Why:** Not strictly a blocker, but this lets us iterate on uploaded videos without re-running the whole expensive pipeline.
**See:** `process_video_v2.py` — `resolve_gemini_uri()`, `auto_captions_to_srt()`, `get_captions_srt()`. Both reprocess functions updated.

### VPAT (Voluntary Product Accessibility Template)
**Why:** University procurement teams require a published VPAT as a gating evaluation artifact. Without one, Chalkboard may not pass initial vendor screening at most institutions — irrespective of how good the product is. This is a documentation task, not an engineering task, but it's a hard prerequisite for closing institutional deals.
**Approach:** Use the ITI VPAT 2.5 template. Document conformance against WCAG 2.1 Level A + AA, Section 508, and EN 301 549. Should be reviewed by an accessibility consultant before publishing.

### Viewer accessibility audit + MathML navigation
**Why:** Our output pages must themselves be fully WCAG 2.1 AA compliant — keyboard navigation, screen reader support, proper ARIA, focus management, and full MathML navigation (moving into a fraction's numerator, exploring inside radicals). Table stakes for an accessibility product. If our viewer isn't itself accessible, we lose credibility instantly.
**Approach:** Audit the viewer with axe-core + manual screen reader testing (NVDA on Windows, VoiceOver on macOS). Validate that KaTeX's MathML output is navigable. Fix gaps before any public university demo.

### Compliance & migration triggers
**Why:** Neither Vercel nor Railway publishes a FERPA statement. The first university procurement RFP will require answering HECVAT with a SOC 2 + FERPA-capable hosting subprocessor. Current stack can't answer that honestly. Also — Railway's managed Postgres had documented data-loss incidents in late 2025 and has no native PITR. Both problems have the same answer: migrate the data-touching path before the first institutional contract.

**Migration map (triggered, not scheduled):**
- **First HECVAT RFP** → Postgres to Neon (Scale plan, SOC 2 Type 2, Vercel-integrated) or AWS RDS (ed-tech procurement gold standard)
- **Postgres > 10 GB or hits 100-connection ceiling** → Neon immediately (Railway's cap will bite first)
- **Worker needs GPU** (e.g. Whisper-large-v2 alignment) OR an institutional customer requires isolated ML compute → Modal for the worker tier
- **Vercel bandwidth overage > $50/mo** → reconsider Cloudflare in front of Railway as a consolidation path (see [ADR-018](./decisions.md#adr-018-platform-architecture--vercel--railway-split-deferred-consolidation))

**Prep work — do before any trigger fires:**
- **Nightly `pg_dump` to R2** — disaster recovery + migration rehearsal in one. Not yet implemented.
- **Keep SQL portable** — no Railway-specific Postgres extensions. Standard SQL only.
- **Dockerfiles + `railway.toml` committed** — stack rebuilds on any container host. Done.
- **Subprocessor list** — maintained in `docs/` before first RFP. Current: Vercel, Railway, Cloudflare R2, Google Gemini, Google Cloud Speech (Chirp), Slack, Webshare.

**See also:** [ADR-018](./decisions.md#adr-018-platform-architecture--vercel--railway-split-deferred-consolidation) for the platform split rationale.

---

## 🟢 Nice-to-have / parking lot

### Infrastructure / DX

- **Browser upload via presigned URLs** instead of proxy through Next.js (avoids large file payloads through serverless)
- **Gemini File API URI caching** — currently we re-upload on every reprocess
- **Cost dashboards** — track Gemini + Chirp 2 spend per video
- **WebSocket progress updates** instead of polling for run status
- **Testing/debug interface** — batch processing UI to run the full MathSpeech corpus (89 MIT lectures) through the pipeline. Per-video results, run diffs, confidence distributions, failure modes. Doubles as a debug interface for extraction issues. Wraps the existing eval harness (`eval/run_eval.py`) with a web UI

### Pipeline quality

- **Cross-chunk visual-content deduplication** — chunks run in parallel with no shared memory, so a slide or board content visible across two adjacent chunks gets extracted twice (observed on `nkePsdYOzwg`: the "Warm-Up" slide captured at 146s AND 300s, CS 70 course-info slide captured 2-3×). Prompt already instructs "don't re-extract content from earlier" but that rule can only police within a single chunk. Fix: post-processing pass after all chunks complete, merging near-duplicates based on (a) text/LaTeX similarity, (b) same content_type, (c) timestamp proximity. Not urgent — duplicates are clutter, not wrong content. Relevant to all types (text, equation, diagram, chart, table, code). See [decisions.md → Prompt determinism v2](./decisions.md#prompt-determinism-v2--beforeafter-on-nkepsdyozwg-2026-04-23) for the baseline observation.
- **Equation end-timestamps are unreliable; drop the "active window" concept** — Gemini's `discussed_end` for equations often snaps to the chunk boundary instead of reflecting when the equation actually stopped being the subject of discussion. Gemini can't reliably maintain "is this equation still being referenced?" state over long spans, so the end value is noise in practice. The `discussed_start` is much more trustworthy. Proposed restructure: stop relying on `discussed_end` for UI active-highlighting in the Lecture Notes sidebar. Replacement behavior options: (a) sticky-until-next-starts — equation N is "active" from its `start` until equation N+1's `start`; (b) fixed window — equation is "active" for a constant window (e.g., 15s) after its `start`; (c) drop the active-window UX entirely and just list equations in scroll order, highlighting the closest one by proximity to `currentTime`. Prompt could also be simplified to only ask for "actively writing" moments, not discussion windows, since we'd stop consuming the end value. Viewer code touching this lives in [GroupedEquations.tsx](../viewer/components/GroupedEquations.tsx) (the `currentTime >= item.start && currentTime <= item.end` active check).
  - **Caveat — mental-board-reconstruction burden.** If we drop the active window and only highlight one equation at a time (by `start`-based proximity), the student loses the "N equations are simultaneously on the board right now" view that a sighted student gets by just looking. In a piecewise derivation (e.g. step 1: $F=ma$, step 2: $F=5\cdot 2$, step 3: $F=10$), a sighted student sees all three together and can refer back visually. With one-at-a-time highlighting, a blind student has to mentally hold the running board state — essentially reconstructing the full board in their head from a sequence of transient highlights. That's cognitively expensive and a real accessibility regression. Mitigations to weigh when we pick an option: (i) expose a visible "currently on the board" group separate from the single highlighted item; (ii) show the last N equations (configurable) as a persistent stack, not just the single proximity-matched one; (iii) keep some form of active window but derive its end from *the next erase event* or *topic-boundary transition* rather than Gemini's `discussed_end`. The last option preserves the "what's on the board" semantics without trusting the unreliable end-timestamp.
- **Equation timestamp alignment** — align equation timestamps against the word-aligned transcript (same approach we use for transcript vs YouTube). Today equation timestamps are raw Gemini output and drift on long videos.
- **Visual map pass** — low-res Gemini pre-pass to identify which sections have visual math content vs speech-only. Powers slide detection, diagram extraction, and lets us skip non-equation sections to save tokens.
- **Confidence-based re-runs** — re-extract low-confidence equations with targeted prompts. The 0.85 threshold rationale lives in [ADR-017](./decisions.md#adr-017-v2-chunking--word-alignment--empirical-validation).
- **Verification pipeline** — multi-tool recursive reprompting for low-confidence extractions ([ADR-014](./decisions.md#adr-014-verification-pipeline--multi-tool-recursive-reprompting-for-low-confidence-extractions))
- **Bounding boxes / spatial coordinates** — have Gemini mark *where* on screen each equation appears. Enables click-to-seek from a board region, spatial layout reconstruction, frame-crop verification. Requires better equation timestamping first.

### Accessibility features

- **Audio descriptions** — synthesized narration in speech gaps describing visual actions ([ADR-015](./decisions.md#adr-015-audio-descriptions--synthesized-narration-synced-to-speech-gaps))
- **Diagram alt-text** — natural-language descriptions of non-equation visuals (e.g., "two parallel plates separated by distance h, positive charge on top..."). Prompt change, not a rendering engine. High compliance value. See [ADR-012](./decisions.md#adr-012-scene-graph--visual-diagram-extraction-phase-23--deferred-skeptical) "easier alternative."
- **Graph/chart alt-text** — describe graphs and charts as structured alt-text (described, not recreated visually)
- **Equation narration for derivations** — generate a "narrated derivation" that connects steps: *"Starting from F equals ma, we substitute the expression for force..."* Helps screen-reader users follow the mathematical reasoning, not just identify individual equations.
- **Multi-language equation captions** — translate transcript text, keep the LaTeX (equations are universal). Opens international student services as a buyer. Gemini handles translation natively — prompt parameter, not new pipeline.
- **Nemeth Braille output** — convert extracted LaTeX to Nemeth Braille notation via existing tools (e.g., `latex2nemeth`). Niche but unique — nobody has math captions in braille for video.
- **Table extraction** — extract tables from lectures in screen-reader-friendly format
- **Slide extraction** — detect and extract slide content (text, diagrams, bullets) in screen-reader-friendly form
- **VTT/SRT export** — emit standard caption formats from segments + equations, for download or re-injection into YouTube. Standard accessibility workflow target; equations would need a LaTeX→readable-text fallback since VTT doesn't render math.

### Viewer / UX

- **Mobile-friendly viewer + dashboard** — current layout assumes a desktop two-column split (video + equations on the left, transcript on the right) with a fixed-height `100dvh` lock and `overflow: hidden` on `body`. On phones this is unusable: the columns squash, the transcript has no room, and the equation panel is unreadable. Needs a responsive breakpoint that stacks the panels (video → tabbed transcript/equations or collapsible sections), removes the body-scroll lock below `md`, and reflows the dashboard header + QueueStrip + ProcessForm into a single column. Touch targets on Retry / Cancel / Reprocess buttons need to hit ≥44 px. Required for student usage outside study sessions and for any disability-services demo done on a tablet/phone.
- **Cross-panel highlighting** — hover an equation card → highlight linked transcript segment. Data linkage already exists in `segment_equations`, just needs frontend wiring.
- **Study guide generation** — use topic map + equations to generate structured summaries (key concepts, equation reference sheet, worked examples). One additional Gemini call per lecture.
- **Reportable moments** — let users flag specific timestamps where extraction looks wrong. One-click reporting captures timestamp, frame, extracted content, and user note.

### Search & cross-lecture features

- **Concept indexing / cross-lecture search** — add embeddings (pgvector) to existing equation entities. Enables *"jump to every moment eigenvalues are discussed across all your lectures."* Buyer: professors linking lectures, students finding topics.
- **Prerequisite linking** — cross-reference equations across lectures: *"This uses integration by parts, covered in Lecture 12 at 34:00."* Requires embedding + clustering work first.

### Integrations (institutional fit)

These are not technically interesting but are commercially critical. Universities buy tools that plug into their existing workflow. Without LMS and lecture-capture integration, Chalkboard hits a procurement objection at every institution.

- **Canvas LMS integration** — Largest higher-ed LMS. Process course videos, embed accessible viewers in assignments, sync rosters for per-student access. Highest priority of the integrations.
- **Blackboard / Moodle / D2L Brightspace** — Round out the "big four" LMS platforms. Same workflow as Canvas integration.
- **Panopto integration** — Panopto is the dominant lecture-capture platform and its auto-captions are documented as poor on STEM (Oxford accessibility audit). Natural opportunity: be the STEM accessibility layer that processes Panopto recordings at the source. Lectures already flow through Panopto → Tier-1 captioning vendors today.
- **Kaltura / Echo360 integration** — Other major lecture-capture platforms.
- **YuJa integration** — Smaller but growing lecture-capture player; some universities standardize on it.

### Strategic / new product surfaces

- **Self-serve demo on landing page** — visitor pastes a YouTube URL, we process 5 minutes of it, results render inline. **Highest-leverage launch action.** With the April 24, 2026 ADA Title II deadline driving disability services directors to evaluate solutions immediately, a paste-URL-and-see-results experience converts awareness into pipeline faster than any other feature. Every captioning vendor is running "countdown to compliance" campaigns — Chalkboard needs a frictionless entry point. Prerequisite: Railway worker architecture (blocker #1) and rate limiting.
- **Batch remediation API for institutional video archives** — Universities have tens of thousands of inaccessible recordings from past semesters (Ohio State libraries: 110,000+ inaccessible PDFs alone; UT Austin's video archive needed 6–9 months to caption). Bulk processing API + institutional dashboard with progress tracking, per-video status, queue priority. Distinct from the internal MathSpeech debug interface — this is a customer-facing capability that powers large institutional contracts and consortium deals.
- **Real-time captioning for live lectures (CART replacement)** — direct response to the documented CART provider shortage for STEM content. NCI launched "Lightning Captions" (an ASR-based CART alternative) in July 2025 specifically because trained STEM stenographers are increasingly scarce. If Chalkboard can provide live captions with rendered equations — something no human CART provider can do — it addresses one of the most painful and expensive disability services bottlenecks. Separate architecture from the batch pipeline (Gemini Live or similar streaming model).
- **Corporate accessibility training videos** — expand beyond STEM lectures. Same pipeline applied to compliance training, onboarding, product demos. Different market (L&D / HR / federal contractor Section 508 compliance), same equation/visual extraction challenges, longer sales cycles but larger deal sizes.

---

> **Historical context:** [ADR-013](./decisions.md#adr-013-future-feature-ideas--ranked-by-feasibility-and-sell) holds the original feasibility-vs-sell tier ranking exercise from 2026-03-17. The active feature inventory now lives above in the parking lot — ADR-013 is preserved as a snapshot of how we were thinking at that point.

---

## ✅ Recently shipped

- **All 7 pre-Railway blockers** — worker architecture (Postgres-polled, FOR UPDATE SKIP LOCKED), R2 storage, DB schema for uploads, HMAC cookie auth, Slack alerting, GCP key handling, Dockerfiles
- **Railway reliability layer** — smoke test (`smoke_test.py`), replay helper (`replay_run.py`), queue-stuck Slack alert, `/api/health` with Docker HEALTHCHECK
- **Chirp 2** for local file captions (replaced Chirp 3 which silently returned 0 words on long files)
- **Dashboard upload UI** with thumbnail generation, failed-state visibility, error messages
- **HTML5 player + VideoSource abstraction** — works for both YouTube and local MP4s
- **v2 topic-aware pipeline** — parallel transcript + visual content extraction across topic sections
- **5 reprocessed landing demos** with current pipeline output
- **`auto_captions` on `pipeline_runs`** — DB now stores the captions used for word alignment
- **Code snippet alt text** — `aria-label` and visible descriptions for accessibility
