# Architecture Decision Records

## ADR-001: Single-provider Gemini pipeline over dual pipeline (STT + Gemini)

**Date:** 2026-03-16
**Status:** Provisional (pending transcript granularity validation)

**Context:** Original design used Google Cloud STT (Chirp 3) for transcription and Gemini for equation extraction, with a merge step. Research showed Gemini can handle both via YouTube URL natively.

**Decision:** Use Gemini for both transcription and equation extraction in a two-pass strategy. Drop STT, ffmpeg, and yt-dlp from the pipeline.

**Why:** Eliminates 3 dependencies and a second API credential. Gemini's multimodal understanding cross-references speech with visual content natively. Cost is comparable (~$0.25/lecture vs ~$0.22 for STT batch + Gemini). Architectural simplicity wins for MVP.

**Risk:** Gemini returns segment-level timestamps (MM:SS), not word-level. If segments are too coarse, viewer sync UX degrades and VTT/SRT exports won't meet captioning standards.

**Validation gate:** Run 3-5 MIT OCW lectures through Gemini transcript extraction. If segments are paragraph-level (>10s), add STT for transcription. Schema is provider-agnostic — only pipeline code changes.

---

## ADR-002: Frame rate as token budget lever, not resolution

**Date:** 2026-03-16
**Status:** Accepted

**Context:** Gemini charges per token for video input. Low resolution (66 tok/frame) vs default (258 tok/frame) significantly affects cost. But Chalkboard's core feature is equation extraction from video frames.

**Decision:** Keep default resolution (258 tok/frame). Use frame rate (0.5 FPS) to manage token budget.

**Why:** Equation legibility — especially handwritten chalk on dark boards — requires every pixel. Low resolution could make equations illegible, defeating the product's purpose. Equations persist on boards for 30-120 seconds, so 0.5 FPS (one frame every 2 seconds) captures every meaningful board state.

**Token math:** 60-min lecture at 0.5 FPS default resolution = ~670K tokens. Fits within 1M context with ~380K headroom.

---

## ADR-003: "Discussed" timestamps on equations, not "visible on board"

**Date:** 2026-03-16
**Status:** Accepted

**Context:** An equation written at minute 3 may stay on the board until minute 20, but the professor stops discussing it at minute 5. Using "visible" timestamps for the merge would link the equation to every transcript segment from 3:00-20:00 — most of which are unrelated.

**Decision:** Equation `timestamp_start/end` stores the "actively discussed" window. The merge step uses these for linking equations to transcript segments.

**Why:** Produces tight, accurate links. Equations only appear in transcript where they're actually being talked about. Controlled via Gemini prompt: "give me the time range when this equation is being actively written or discussed."

**Future:** If we later want a sidebar showing "equations currently visible on board," add `visible_start/visible_end` columns. Not needed for MVP.

---

## ADR-004: Two-pass Gemini extraction over single-pass

**Date:** 2026-03-16
**Status:** Accepted

**Context:** Gemini has a 65K output token hard limit. Exceeding it returns `None` (not partial output). A 60-minute lecture transcript + equation entities in a single response risks hitting this.

**Decision:** Run two separate Gemini calls on the same video: pass 1 for transcript, pass 2 for equations.

**Why:** Each response stays well under the output limit. Context caching makes pass 2 nearly free on input tokens (~90% discount). Both passes still receive the full video (audio + visual), so multimodal cross-referencing is preserved in each pass independently.

---

## ADR-005: YouTube-only input for MVP

**Date:** 2026-03-16
**Status:** Accepted

**Context:** Hosting and serving video files adds complexity (object storage, ffmpeg processing, file upload UI). MIT OCW lectures are freely available on YouTube.

**Decision:** Accept only YouTube URLs as input. Gemini processes YouTube URLs natively.

**Why:** Zero video hosting for MVP. Instant access to hundreds of real STEM lectures for testing. YouTube iframe API provides the viewer player with seek and time-tracking. The coupling is shallow — swapping to HTML5 `<video>` with self-hosted files changes only the player component, not the data model or pipeline.

---

## ADR-006: Equations as first-class entities with join table

**Date:** 2026-03-16
**Status:** Accepted

**Context:** Equations could be stored as inline text within transcript segments, as a UUID array on segments, or as their own table with a join table.

**Decision:** Equations get their own table. A `segment_equations` join table links them to transcript segments with `ON DELETE CASCADE` and a `position` column.

**Why:** Every future feature plugs in cleanly: search, similarity clustering, review workflow, export, embeddings. Join table gives referential integrity, easy reverse lookups, and a natural place for metadata. UUID arrays can't enforce FKs — a deleted equation leaves a dangling ID with no error.

---

## ADR-007: Re-discussed equations as separate rows

**Date:** 2026-03-16
**Status:** Accepted

**Context:** A professor might write F=ma at minute 5, reference it again at minute 35. How to model multiple discussion windows for the same equation?

**Decision:** Create separate equation rows with the same `latex_string` but different timestamps.

**Why:** Keeps the merge step simple — each equation row maps to one discussed window. Slightly denormalized but correct. Dedup and grouping (recognizing these are the "same" equation) is a Phase 2 concern (similarity clustering via embeddings).

---

## ADR-008: Accuracy strategy — defer verification layers

**Date:** 2026-03-16
**Status:** Deferred (revisit after accuracy testing)

**Context:** Gemini equation extraction accuracy is unknown. To hit ~99% accuracy, we may need: (1) MathPix as a verification layer for low-confidence extractions, (2) repeated Gemini revisit calls on low-confidence equations with targeted prompts, or (3) both.

**Decision:** Don't build verification layers yet. The `confidence` field on equations exists for thresholding. The `verified` column is planned for Phase 1 review workflow.

**Why:** We don't know the actual failure modes yet. Building verification infrastructure before seeing real accuracy numbers on real lectures is premature. Run 5-10 test lectures first, manually grade, then design the verification strategy around the actual failure patterns.

**Future path when needed:**
- Low-confidence equations (below threshold) → re-extract with Gemini using a more targeted prompt (e.g., send just the frame snapshot + surrounding audio context)
- Still low-confidence → route to MathPix OCR as a second opinion
- Still uncertain → flag for human review (Phase 1 review UI)

---

## ADR-009: Inline LaTeX in transcript text

**Date:** 2026-03-16
**Status:** Accepted

**Context:** Original design had plain-text transcripts (Pass 1) and separate equation entities (Pass 2), merged by timestamp. The transcript displayed plain text like "one half Q V" while equations appeared in a separate panel. This missed the core product insight: the transcript with rendered equations IS the product.

**Decision:** Pass 1 now prompts Gemini to embed LaTeX inline using `$...$` delimiters. The viewer parses these and renders them with KaTeX directly in the transcript flow. Pass 2 (separate equation entities) still exists for the equations panel, search, and future features.

**Why:** Users see "the energy is $\frac{1}{2}QV$" rendered as real math in the transcript — not plain text on one side and a separate equation on the other. Gemini sees and hears everything simultaneously, so asking it to produce inline LaTeX leverages its multimodal capability directly.

---

## ADR-010: LaTeX JSON escape fix post-processing

**Date:** 2026-03-16
**Status:** Accepted

**Context:** JSON escape sequences collide with LaTeX commands: `\f` (form feed) eats `\frac`, `\t` (tab) eats `\text`, `\b` (backspace) eats `\beta`, etc. This happens during JSON parsing of Gemini's structured output, before our code touches the data. Using `response.parsed` from the SDK doesn't help — it goes through the same JSON parser.

**Decision:** Post-processing step in `src/extraction/latex_fix.py` that detects control characters inside `$...$` blocks and restores the original backslash+letter sequences. Applied to both transcript text and equation LaTeX strings in `process_video.py`.

**Why:** The alternative (telling Gemini to double-escape backslashes) is fragile and prompt-dependent. Post-processing is deterministic and catches all cases regardless of how the model outputs LaTeX.

---

## ADR-011: Eval harness — containment-based matching against MathSpeech

**Date:** 2026-03-17
**Status:** Accepted

**Context:** MathSpeech (AAAI 2025) provides 1,101 ground truth equations across 89 YouTube lectures. However, MathSpeech annotated equations piecewise from speech (fragments as the professor spoke them), while our pipeline extracts whole equations from the board visually. A single Gemini extraction may contain multiple MathSpeech fragments. Additionally, MathSpeech ground truth is speech-derived and contains errors that visual extraction does not — e.g., uppercase `Ax + By + Cz = D` when the board shows lowercase `ax + by + cz = d`, or square brackets `[x-2,y-1,z+1]` when the board shows angle brackets `⟨x-2, y-1, z+1⟩`.

**Decision:** Containment-based matching (normalized ground truth as substring of normalized extraction) with fuzzy fallback (CER < 0.3). Eval results are a floor, not a ceiling — some "misses" are the pipeline being correct and the ground truth being wrong.

**Why:** Exact match would unfairly penalize the pipeline for extracting more complete equations than the ground truth fragments. Visual extraction is fundamentally more accurate than speech-based annotation for notation details (case, bracket style, symbol choice), so ground truth disagreements should not automatically count against the pipeline.

**Eval location:** `eval/` directory. Run with `python eval/run_eval.py`. Extract individual videos with `--extract` flag (1 Gemini call each). Runs offline against saved JSON otherwise.

---

## ADR-012: Scene graph / visual diagram extraction (Phase 2.3) — deferred, skeptical

**Date:** 2026-03-17
**Status:** Deferred (needs feasibility spike + honest demand assessment)

**Context:** The roadmap's Phase 2.3 proposes having Gemini interpret drawn diagrams and graphs from lecture video and output structured scene descriptions (objects, positions, transformations over time) that render as interactive SVG/canvas visualizations in the viewer.

**Architecture if built:**
- Pass 3 (new): Gemini describes visual diagram as a scene graph with primitives (plate, arrow, label, line) + positions + events keyed to timestamps
- Output: `{ objects: [{type, id, position}], events: [{timestamp, action, target, delta}] }`
- Frontend: React component interprets scene graph, renders SVG/canvas synced to video playback

**Feasibility layers:**
- Easy: Gemini can describe what's on the board in structured terms (already does this for equation descriptions)
- Medium: Translating to renderable primitives with a constrained output format
- Hard: Tracking motion accurately over time (spatial layout + temporal evolution from video frames)

**Decision:** Defer. The honest question is whether anyone would use this. If you want to see visuals, watch the lecture. The accessibility angle has some merit — a screen reader could narrate diagram state changes — but it's a product in itself, not a feature. The equation extraction we've built is the foundation; this is a separate bet.

**Next step if revisited:** Pick one Walter Lewin lecture, prompt Gemini to describe board state as a scene graph, evaluate the output quality before committing to the architecture.

---

## IMMEDIATE TODO: Self-serve demo on landing page

**Date:** 2026-03-18
**Status:** Immediate priority

**Idea:** Replace the static demo on the landing page with a live "try it yourself" experience. Visitor pastes any YouTube STEM lecture URL, we process 5 minutes of it, and they see the result right there. No meeting, no outreach friction. The demo IS the sales call.

**Copy concept:** "Try it on any lecture. Paste a YouTube URL — we'll transcribe 5 minutes with rendered equations. Pick a calculus or physics video and watch it work."

**Requirements:**
- Landing page needs a URL input that triggers real pipeline processing
- Pipeline needs to support time-limited extraction (5 min cap via `videoMetadata` start/end offsets)
- Results display inline on the landing page (reuse DemoViewer with dynamic data)
- Needs the pipeline running server-side — can't be static-only Vercel deploy. Needs a backend (Railway, Fly.io, or Vercel with serverless function + external pipeline server)
- Rate limiting / abuse prevention (cap free demos per IP or require email)
- Cost per demo: ~$0.05 for 5 minutes at 0.5 FPS (very cheap)

**Why this changes deployment:** The landing page can't be static-only if it triggers real processing. Options:
1. Vercel for frontend + separate API server (Railway/Fly) running the Python pipeline
2. Single server (Railway/Fly) running both Next.js and the pipeline
3. Vercel with a serverless function that calls the pipeline API

**Friction to dev cycle:** Moderate. The pipeline already works as a CLI script. Need to wrap it as an HTTP API (FastAPI is already in the stack but unused). Then the landing page calls that API instead of spawning a local subprocess.

---

## ADR-012: Scene graph / visual diagram extraction (Phase 2.3) — deferred, skeptical

**Easier alternative with higher compliance value — diagram alt-text:** Instead of rendering interactive diagrams, have Gemini output natural language descriptions of visual diagrams keyed to timestamps — "Two parallel plates separated by distance h, positive charge on top plate, negative charge on bottom, uniform electric field lines pointing downward between them." This is essentially the `description` field we already have on equations, extended to non-equation visuals. Screen readers get it for free, ADA compliance teams can point to it, and it's a prompt change — not a rendering engine. Worth doing before the full scene graph approach.

---

## ADR-013: Future feature ideas — ranked by feasibility and sell

**Date:** 2026-03-17
**Status:** Noted (not committed)

### Tier 1 — Close to what we already have, high sell

**Concept indexing / cross-lecture search.** We already have equation entities with timestamps + descriptions. Add embeddings (Phase 2 in roadmap, pgvector) and you get: "Jump to every moment eigenvalues are discussed across all your lectures." No captioning vendor does this. The buyer: professors who want to link lectures, students who want to find specific topics.

**Study guide generation.** Take the transcript + equations from a processed lecture and generate a structured summary: key concepts, equation reference sheet, worked examples. One additional Gemini call per lecture. Students want this more than captions. Could be an export alongside the viewer.

**Multi-language equation captions.** Translate the transcript text, keep the LaTeX (equations are universal). Suddenly accessible to international students, not just disabled students. The compliance buyer expands to international student services. Gemini handles translation natively — it's a prompt parameter, not a new pipeline.

### Tier 2 — Pushes the accessibility boundary, real compliance value

**Diagram alt-text.** (See ADR-012 alternative.) Describe non-equation visuals in natural language, keyed to timestamps. Prompt change, not a rendering engine. High compliance sell.

**Equation narration for derivations.** The `description` field labels individual equations but can't convey a derivation story. Generate a "narrated derivation" that connects steps: "Starting from F equals ma, we substitute the expression for force..." This helps screen reader users follow the mathematical reasoning, not just identify individual equations.

### Tier 3 — Technically possible, unclear demand

**Nemeth Braille output.** LaTeX can be converted to Nemeth Braille notation via existing tools (e.g., latex2nemeth). If we're already extracting clean LaTeX, we're one conversion step from braille-ready math for video content. Nobody has this. But the user base is very small and the conversion tooling is brittle.

**Prerequisite linking.** Cross-reference equations across lectures: "This uses integration by parts, covered in Lecture 12 at 34:00." Requires the equation embedding + clustering from Phase 2. Cool but complex dependency chain.

**Interactive scene graph rendering.** (See ADR-012 main proposal.) Full diagram extraction and rendering. A product in itself.

**Notes/concepts view instead of equations panel.** Replace atomic equations with structured notes — "Example 1: Deriving the quadratic formula" with a brief explanation, time-synced. Basically an AI-generated study guide sidebar. Concern: this is AI summary territory and doesn't differentiate us from other AI classroom products (like Notion AI, Otter, etc.). Probably mutually exclusive with the equations panel. Low priority unless users specifically ask for it.

**Chunked transcription + YouTube caption alignment solves both coverage and drift.**

Tested on Walter Lewin (49 min):

| Approach | Words | vs YouTube | Drift (avg) |
|---|---|---|---|
| Unchunked | 5,385 | 74% | +5.2s (25-30 min: +28.5s) |
| 10-min chunks | 7,014 | 96.5% | +5.2s pre-align, -0.9s post-align |
| 5-min chunks | 7,080 | 97.4% | not measured |
| YouTube captions | 7,272 | 100% | 0s (reference) |

10-min chunks are the sweet spot — 5-min chunks cost 2x for only 0.9% more coverage. YouTube caption alignment brings average drift from +5.2s to -0.9s per 5-min window. The aligner uses monotonic sequential ngram matching with interpolation for unmatched segments.

**Timestamp drift accumulates over long videos.** Gemini's timestamps are accurate at the start of a video but drift by ~1 minute by the 7-minute mark on some videos. Likely caused by Gemini compressing pauses/gaps. Both 2.5 Flash and 3 Flash exhibit similar drift on the same video. This means transcript-to-video sync degrades over time. Potential fix: use Google Cloud STT for precise word-level timestamps and align Gemini's transcript segments against them — using STT for timing only, not transcription content. This is a variation of the original dual-pipeline approach. Not critical for short videos (<10 min) but matters for full lectures.

**Confidence scoring validates itself.** Across all processed videos, the lowest confidence score (0.8) was the only extraction error (Feynman derivative). All correct extractions scored 0.9+. A threshold of 0.85 would flag exactly the problematic cases without false positives. Silent board work: all 1.0. Walter Lewin: 0.9–0.99. Partial derivatives: 118/122 at 1.0. The confidence field is a reliable signal for quality gating.

**Confidence-based targeted re-runs.** The Feynman lecture exposed a real extraction error (extra dot on a derivative in barely-legible 1964 footage — confidence was 0.8). Strategy: when Pass 2 returns equations with confidence below a threshold, re-run just those timestamp windows with a more capable model (2.5 Pro or 3 Flash). Requires testing whether 2.5 Pro or 3 Flash actually produce better results on low-confidence cases — unknown as of 2026-03-18. The confidence field already exists on every equation. Implementation: filter equations below threshold, extract frame snapshots at those timestamps, re-run Gemini with a targeted prompt ("here is a frame, what equation is written?") using the stronger model. Only worth building after confirming the stronger model actually improves on Flash's failures.

**Cross-panel highlighting.** Hovering an equation card highlights its linked transcript segments, and vice versa. Subtle visual connection (line or flash) to show the two panels are views of the same moment. The data linkage already exists in `segment_equations` — just needs frontend wiring. High-value UX improvement for the real viewer.

**Streaming whiteboard reconstruction.** 3rd Gemini pass to extract math symbols with positions, rendering a virtual whiteboard that builds up as the instructor writes. Users see a clean digital version of the board being constructed in real time. Technically interesting but low value — if you want to see the board, watch the video. The transcript with inline LaTeX already captures the content without needing to reconstruct the visual layout.

---

## ADR-014: Verification pipeline — multi-tool recursive reprompting for low-confidence extractions

**Date:** 2026-03-22
**Status:** Planned (supersedes ADR-008's "defer" decision — we now know the failure modes)

**Context:** ADR-008 deferred verification layers until we understood accuracy failure modes. We now know them: Gemini 3 Flash produces reliable results on clean video (0.9+ confidence, validated correct), but fails on nightmare scenarios — blurry whiteboards, strong accents, low-quality video, 1964 Feynman footage. The confidence field reliably flags these cases (the only extraction error across all testing scored 0.8, the lowest). The question is no longer "should we build verification" but "how."

**Decision:** Low-confidence extractions get re-ingested through a multi-tool verification pipeline that uses the best specialized tool for each modality, orchestrated by the Gemini 3.1 Pro reasoning model.

**Architecture:**

```
Flash extraction (confidence < 0.85 threshold)
    │
    ├──→ Mathpix API: OCR the frame snapshot → LaTeX (visual ground truth)
    │
    ├──→ Chirp 3 (Google Cloud STT): raw transcript of that timestamp window
    │    → what the professor actually said (speech ground truth)
    │
    ├──→ Original video + audio segment: re-ingested at full resolution
    │
    └──→ All three signals fed to Gemini 3.1 Pro (reasoning model):
         "Here is a frame, the OCR reads [X], the speech says [Y],
          the video shows [Z]. What is the correct LaTeX?"
         → high-confidence verified extraction
```

**Why multi-tool instead of just a stronger model:**

- Flash fails because the input is ambiguous (blurry frame, unclear speech). A stronger model looking at the same ambiguous input may not do better.
- Mathpix is purpose-built for math OCR — it will read a blurry whiteboard better than any general-purpose multimodal model.
- Chirp 3 is purpose-built for speech — it will parse a thick accent better than Gemini's built-in audio processing.
- The 3.1 Pro reasoning model's job isn't to re-extract — it's to adjudicate between multiple signals that may disagree. This is what reasoning models are good at.

**Why 3.1 Pro specifically:** Reasoning models excel at synthesis tasks with conflicting evidence. "Mathpix says `\frac{d}{dt}`, Chirp 3 heard 'derivative of r', the video shows a dot notation" — the reasoning model resolves this better than a fast model.

**Testing strategy:** Validate on true nightmare scenarios — strong accented professor, low-quality video, blurry whiteboard, fast handwriting. If the multi-tool pipeline doesn't meaningfully improve on Flash alone for these cases, don't build it.

**Cost model:** Only fires on low-confidence extractions. Across all testing, <5% of equations fall below 0.85. At ~$0.10 per verification (Mathpix + Chirp 3 + Pro reasoning call), adds <$0.50 per lecture in the worst case. Acceptable for a product charging $1-2/minute.

---

## ADR-015: Audio descriptions — synthesized narration synced to speech gaps

**Date:** 2026-03-23
**Status:** Planned

**Context:** Blind students miss visual actions that aren't narrated: the professor writing on the board in silence, erasing a section, pointing at a diagram, performing a physical demonstration. Standard captions and our current visual content extraction capture what's on the board, but not what's happening in the room. Descriptive video service (DVS) exists for TV/film but not for lectures.

**Decision:** Build an audio description system that generates synthesized narration describing visual actions, inserted into natural pauses in the lecture audio.

**Architecture:**

```
Lecture video
    │
    ├──→ Audio level analysis: detect gaps/pauses in speech
    │    → produces list of (start, end, duration) silence windows
    │
    ├──→ Gemini video pass (scene description mode):
    │    → "What is the professor DOING visually in this segment?"
    │    → content_type: scene_description, demonstration, speaker_action
    │    → fits into existing visualContent schema (extensible content_type)
    │
    └──→ For each silence window with a matching scene description:
         ├──→ TTS synthesis (Google Cloud TTS / ElevenLabs)
         │    → generate audio clip of the description
         └──→ Mix into lecture audio at the gap timestamp
              → output: enhanced audio track with descriptions
```

**Key design principles:**

- **Sync to silence:** Descriptions only play during natural pauses in speech — never talk over the professor. Audio level analysis finds windows where descriptions can fit.
- **Brevity constraint:** Description text must be short enough to fit the available gap. If the gap is 3 seconds, the description can't be 10 seconds. TTS duration estimation guides text length.
- **Separate from board content:** This is a different Gemini pass with a different prompt. Board content extraction ("what's written") stays as-is. Scene description ("what's happening") is additive.
- **Uses existing schema:** The `visualContent` array and `content_type` field already support arbitrary types. Scene descriptions use `scene_description`, `demonstration`, `speaker_action` — no schema migration needed.

**Why this matters for compliance:** WCAG 2.1 AA requires audio descriptions for prerecorded video (Success Criterion 1.2.5). No lecture captioning vendor provides this. Universities that need full WCAG compliance currently have no scalable solution for STEM lectures.

---

## ADR-016: Pipeline observability — Slack webhook alerting for production

**Date:** 2026-03-31
**Status:** Planned

**Context:** When the pipeline runs in production (Railway), failures are invisible. The current loop is: client uploads → something breaks → client reports it (maybe) → we ask for video ID → we investigate → we fix. This is unacceptable for a demo-stage product where every failure erodes trust. We need to know about failures before the client does.

**Decision:** Add a Slack webhook notification system to the pipeline. Notify on both failure and success.

**On failure, the notification includes:**
- Video title + source (YouTube URL or uploaded filename)
- Which pipeline stage failed (captions, topic map, extraction, alignment, saving)
- Error summary (last line of traceback)
- Run ID + direct link to the dashboard debug page
- Video duration
- Partial progress (e.g., "3/9 sections completed before failure")

**On success, the notification includes:**
- Video title + source
- Segment count, equation count, visual content count
- Word alignment coverage (% of Gemini words matched to captions)
- Quality flags: word coverage <90% gets a warning, <80% gets an alert
- Processing time
- Direct link to the video viewer page

**Implementation:** Single function `notify_pipeline_event()` in the pipeline. One env var: `CHALKBOARD_SLACK_WEBHOOK`. Uses `requests.post()` with Slack Block Kit formatting. Called from `process_video()` in both the success and except branches. ~50 lines of code.

**Why Slack over alternatives:**
- **vs. email:** Slack is instant, threaded, and searchable. Email gets buried.
- **vs. Sentry:** Sentry is overkill for a pipeline with one operator. Slack gives us the same alerting without another vendor, another dashboard, another credential.
- **vs. dashboard polling:** We'd have to remember to check. Slack pushes to us.

**Why notify on success too:** Quality issues (low word coverage, missing equations) aren't errors — the pipeline "succeeds" but the output is bad. Seeing every result lets us catch quality regressions before they reach the client. It also builds intuition for what "normal" looks like, so anomalies stand out.

**Future:** If we outgrow Slack webhooks (multiple operators, SLA tracking, incident management), upgrade to a proper observability stack. But for demo stage, this is the right level of complexity.

**Dependencies:**
- Audio level analysis (librosa or ffmpeg-based silence detection)
- TTS API (Google Cloud TTS, ElevenLabs, or browser-native)
- Scene description prompt (separate from visual content prompt)
- Audio mixing (ffmpeg)

---

## ADR-017: Worker error handling — fail loudly, not defensively

**Date:** 2026-04-14
**Status:** Proposed

**Context:** `worker.py`'s `dispatch` function currently wraps every pipeline call in a broad `except Exception` that catches anything the inner pipeline function didn't handle, writes a truncated traceback to `run.error`, and flips the row to `failed`. The stated intent is "defense in depth" for bugs that slip through. In practice this conflates three very different failure modes — bad queued params, worker-side bugs, and pipeline-side bugs — into one indistinguishable outcome that looks like a normal video-specific failure. See KI-002 in known-issues.md.

**Decision:** Remove the broad `except` from `dispatch`. Replace it with two narrower mechanisms:

1. **Up-front params validation.** Each `run_type` has a known set of required keys (`video_id`, `youtube_url`, `start_time`, etc.). Validate these at the top of `dispatch` before calling the pipeline function. If validation fails, mark the run `failed` with a specific message (`"invalid params: missing video_id"`) and return — this is a known, expected error mode that deserves a clear status.

2. **Let everything else propagate.** Unhandled exceptions inside the pipeline function bubble up to `main`'s existing `except Exception`, which logs the full traceback (no 2000-char truncation) and continues polling. Add one line in `main`'s handler to also mark the in-flight run as `failed` with the full traceback, so the DB row doesn't get stuck in a non-terminal status.

**Why:**
- **Operators get distinguishable signals.** A queueing bug looks different from a pipeline bug looks different from "this video is hard." Once ADR-016 Slack alerting ships, the alert payload can include this distinction instead of shrugging at every failure.
- **Full tracebacks survive.** 2000-char truncation routinely cuts off inner frames; stderr has no limit.
- **Redundancy removed.** `main`'s `except` already handles worker survival. The `dispatch` `except` was duplicating that job while adding noise.
- **Known failures stay handled.** The narrow validation layer catches the one failure mode that genuinely is expected (malformed queue rows from API bugs), with a specific message operators can act on.

**Why not keep the current broad catch "just in case":**
- "Just in case" exception handlers are how bugs hide for months. Every alert that fires and turns out to be a worker-code bug erodes trust in alerting — the next real failure gets ignored.
- If a new exception class appears that we genuinely want to handle gracefully, we can add a narrow `except` for it specifically, with an error message that names what happened.

**Trade-off:** An unhandled exception inside the pipeline function will now log louder. That's the point. If a specific exception turns out to be benign and common (e.g. transient Gemini 500s we want to auto-retry), we add a narrow handler for *that* case with retry logic — not a catch-all that hides everything.

**Related:** KI-002 (current state), ADR-016 (Slack alerting, downstream consumer of this distinction).

---

## ADR-018: Platform architecture — Vercel + Railway split, deferred consolidation

**Date:** 2026-04-16
**Status:** Accepted (with migration triggers)

**Context:** Both `viewer/` (Next.js) and `pipeline/` need hosting. Vercel is optimized for Next.js delivery (edge CDN, ISR, preview deploys, serverless functions). Railway is optimized for long-running containers (persistent compute, managed Postgres, Python/ffmpeg workloads). Currently split: Vercel hosts the marketing landing page at `chalkboard.video`; Railway hosts the Next.js app (dashboard, viewer, API routes), the Python worker, and Postgres. Domain is already on Cloudflare DNS. Evaluated consolidation onto Cloudflare + Railway alone (drop Vercel, use Cloudflare's edge cache in front of Railway-origin Next.js).

**Decision:** Keep the split. Don't consolidate to Cloudflare + Railway today. Plan for a FERPA-driven migration of Postgres (and possibly the worker) when the first institutional RFP lands.

**Why:**
- **Vercel cannot host the Python worker.** 800s function timeout, Python runtime still in beta, 500MB bundle cap. Pipeline jobs run 1-5 minutes, need ffmpeg + persistent memory. This is a hard constraint of Vercel's serverless model, not a limit we grow out of.
- **Marketing uptime decoupled from Railway iteration.** We push Railway 10+ times a day while iterating on the pipeline. Every deploy is a chance Railway has a blip. `chalkboard.video` going down in front of a prospect is materially worse than a demo glitching — prospects forgive broken demos, not broken websites.
- **Vercel Hobby is $0 at our stage.** No cost pressure to consolidate.
- **Consolidation is viable but not urgent.** Cloudflare + Railway alone works — Cloudflare has 330+ PoPs (vs Vercel's ~40), configurable edge caching, "Always Online" for stale-content fallback if Railway is down. But it requires one-time cache-rule configuration and loses `next/image` optimization. Marginal benefit at current scale.

**Consolidation trigger (flip to Cloudflare + Railway alone):** Maintenance friction from two deployment targets exceeds the cost of reconfiguration, OR Vercel bandwidth overage crosses ~$50/mo. Neither likely before first paying customers.

**FERPA trigger (separate and more important):** First institutional RFP that mentions HECVAT or FERPA-specific vendor clauses. Neither Vercel nor Railway publishes a FERPA statement or appears on a university-accepted subprocessor list. When that RFP lands, migrate Postgres to **Neon** (Scale plan — SOC 2 Type 2, native Vercel integration, branching for preview deploys) or **AWS RDS** (FERPA gold-standard for ed-tech procurement). Possibly also move the worker to **Modal** for SOC 2 + HIPAA isolation of the component that touches student video.

**Portability hygiene (enforced starting now to make the future migration a weekend, not a quarter):**
- No Railway-specific Postgres extensions. Standard SQL only.
- Dockerfiles + `.env.example` committed so the stack rebuilds on any container host.
- Nightly `pg_dump` to R2 serves as both disaster recovery and migration rehearsal (not yet implemented — tracked in ROADMAP.md).

**Trade-off:** Two deployment targets to maintain. Small Next.js changes deploy to both (Vercel picks up automatically, Railway on next build). Mental overhead is real but bounded — accepted because marketing-uptime independence is worth it during heavy pipeline iteration.

**Related:** ROADMAP.md → "Compliance & migration triggers" (the operational counterpart), CLAUDE.md → "Platform constraints" (the coding-time guardrails).

---

## Prompt determinism v2 — before/after on `nkePsdYOzwg` (2026-04-23)

**Context:** The visual-content prompts (v0.2) left Gemini too much freedom over output shape — same video, different runs produced different structure. Tables got free-form `description` with no verbalization format; code snippets lost organization; text items came out as prose blobs even when the source was a heading + bulleted list. Specific triggering example: the "Warm-Up" board from `nkePsdYOzwg` (CS 70 discrete math, 1h24m) was stored as a single flat string concatenating the title, question, and three bullets.

Also detected: a granularity anti-pattern in the equations prompt (v0.3) — professors writing multi-step derivations (`F = ma`, `F = 5·2`, `F = 10` on three lines) got merged into one compound `latex` string (`F = ma = 5·2 = 10`) about 2% of the time.

**Baseline** — Railway production run `4479fd31-...`, prompts v0.3 equations + v0.2 visual:
- 789 transcript segments, 92 visual items (47 text, 31 equation, 13 diagram, 1 chart, 0 code/table/other)
- 2 multi-step-latex anti-patterns (e.g. `2k - 1 = 2k - 2 + 2 - 1 = 2k - 2 + 1 = 2(k - 1) + 1`)
- All 47 text items stored as flat `description` strings — zero structure
- 2+ duplicate "Warm-Up" captures, 3+ CS-70 course-info captures with prose variations

**After (v0.4 equations + v0.3 visual, same video, local re-run):**
- 671 transcript segments (word-aligned; lower due to de-dup merging), 134 visual items (63 text, 60 equation, 8 diagram, 0 chart, 3 other, 0 code, 0 table)
- **0 multi-step-latex anti-patterns** (granularity rule caught both baseline cases)
- Equations up 94% (31 → 60) — expected, this reflects finer-grained per-line extraction, not extra content
- **63/63 text items carry structured `textBlocks[]`** (heading / paragraph / bullet with depth) — the "Warm-Up" board is now 5 semantic blocks; screen readers navigate it as a proper list
- `other` used sensibly 3× — all three are professor's hand-drawn QED-style proof-completion squiggles (genuine non-board-text content); prompt's escape-hatch rule is holding
- Section titles follow the new style (Title Case, no "Introduction to", ≤ 50 chars): e.g. "Proof for the Sum of Even Integers" (not "Introduction to Proofs")
- Duplicates reduced but not eliminated — the "same board captured twice when professor refers back" case still produces two entries. That's a separate scope (temporal de-dup) not addressed here

**Ship decision:** Ship. Every target in the design spec landed: granularity anti-pattern eliminated, structured text output at 100%, templated diagram/chart descriptions, `other` as a well-behaved escape hatch, topic-map style rules followed. Couldn't test `table`/`code` end-to-end because this video contains neither — deferred to first STEM-with-tables video processed after deploy.

**Scope note on variance measurement:** The plan originally called for 3 back-to-back runs to measure intra-prompt variance. Burned only 1 run to preserve API budget; the before/after comparison against the Railway baseline proves the DIRECTION is correct, but doesn't quantify how much residual variance remains across runs of the new prompts. Next time this video is reprocessed (e.g. when someone reruns it via the dashboard), diff that run against this one for a variance read.

**Files changed:** `pipeline/src/extraction/schemas.py`, `pipeline/src/extraction/prompts.py`, `pipeline/src/extraction/topic_map.py`, `pipeline/scripts/process_video_v2.py`, `pipeline/tests/test_schemas.py`, `pipeline/tests/test_prompts.py`, `viewer/lib/types.ts`, `viewer/lib/transform.ts`, `viewer/components/TextBlocks.tsx` (new), `viewer/components/GroupedEquations.tsx`. Version bumps: `EQUATIONS_PROMPT_VERSION v0.3 → v0.4`, `VISUAL_CONTENT_PROMPT_VERSION v0.2 → v0.3`, `TOPIC_MAP_PROMPT_VERSION` (new) `v0.2`.

**Spec:** [`docs/superpowers/specs/2026-04-23-prompt-determinism-design.md`](superpowers/specs/2026-04-23-prompt-determinism-design.md) · **Plan:** [`docs/superpowers/plans/2026-04-23-prompt-determinism-plan.md`](superpowers/plans/2026-04-23-prompt-determinism-plan.md)

---

## ADR-019: Persist raw Gemini call logs in R2 with a DB manifest

**Date:** 2026-05-06
**Status:** Accepted

**Context:** A successful production run missed visual equations for a
specific time range. The DB showed final extracted rows, but not the literal
Gemini chunk response. For older v2 runs, `process_video_v2.py` recorded token
usage only; raw `response.text`, parsed output, prompts, and failed attempts
were not persisted. This made the highest-value investigation question
unanswerable: did Gemini return nothing, return malformed data that we
dropped, or return content that a later step filtered out?

**Decision:** For every v2 Gemini attempt, persist:

- Full rendered prompt context and request metadata
- Model, prompt version, schema, section index, time window, FPS
- Raw `response.text`
- Parsed response object when available
- Usage metadata
- Exception details for failed attempts

Store heavy blobs in private R2 objects:

```text
debug/gemini-call-logs/{run_id}/{call_id}.json
```

Store only the compact manifest in Postgres at
`pipeline_runs.gemini_call_logs`. The manifest is what `/debug` uses to list
calls, group them by section, and lazy-load individual blobs through an
auth-gated API route.

**Why R2 instead of JSONB-only:** Raw prompts and responses are operator
forensics, not relational query data. Keeping blobs out of Postgres avoids
large-row growth and keeps a future FERPA-driven DB migration lighter. The DB
still has the durable index needed to discover and join logs to runs.

**Failure policy:** Raw-log persistence is non-fatal. If R2 writes fail, the
pipeline still completes student output, records `capture_status` as
`partial` or `failed`, and stores per-call `capture_error` details in the
manifest.

**Security:** `/video/<id>` remains public. `/video/<id>/debug` and
`/api/runs/<run_id>/gemini-call-logs/<call_id>` require dashboard auth because
raw logs include internal prompts and model outputs.

**Operational impact:** New investigations should first check whether the
content is present in DB, then inspect `/debug` → Raw Calls for the relevant
section before replaying. Runs created before this ADR cannot be backfilled;
their literal Gemini outputs were never stored.
