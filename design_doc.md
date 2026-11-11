# Chalkboard — Design Document

**One-liner:** YouTube lecture URL → accessible web page with synced transcript where equations render as LaTeX via KaTeX.

**Core differentiator:** No captioning service renders LaTeX/MathML in captions. Chalkboard uses Gemini's multimodal video understanding to extract equations visually and cross-reference them with speech — something no audio-only STT or OCR-only tool can do.

---

## Architecture overview

Single-provider pipeline using Gemini Video API for both transcription and equation extraction, delivered as a two-pass strategy over the same video input.

```
YouTube URL
    │
    ├──→ Gemini Pass 1: Transcript extraction (speech → segments with timestamps)
    │
    ├──→ Gemini Pass 2: Equation extraction (visual → LaTeX entities with timestamps)
    │         (uses context caching — ~90% discount on input tokens)
    │
    ├──→ Merge: link equations to segments by discussed-timestamp overlap
    │
    └──→ Postgres
          │
          └──→ Next.js viewer (KaTeX rendering, synced playback)
```

### Why two passes instead of one

The 65K output token limit is a hard ceiling — exceeding it returns `None`, not partial output. A 60-minute lecture's transcript plus equation entities in a single structured JSON response risks hitting this limit. Two passes keep each response well under the ceiling while maintaining the multimodal cross-referencing benefit (each pass receives the full video with audio + visual).

Context caching makes the second pass nearly free on input tokens since the video is already cached.

### Why Gemini only (no Google Cloud STT)

**This is a provisional decision, pending validation.**

Gemini handles both transcription and equation extraction, eliminating: ffmpeg audio extraction, Google Cloud STT SDK, yt-dlp video download, a second API credential, and the complexity of coordinating two async pipelines.

**The risk:** Gemini returns segment-level timestamps (MM:SS), not word-level. If segments are too coarse (paragraph-level, 15-30 seconds), the viewer sync UX degrades and VTT/SRT exports won't meet captioning standards.

**Validation gate (do this first):** Run 3-5 MIT OCW lectures through Gemini with the transcript extraction prompt. Evaluate:
1. Segment granularity — are segments sentence-level (2-5s) or paragraph-level (15-30s)?
2. Timestamp accuracy — do segments align with actual speech?
3. Technical vocabulary — does it handle STEM terminology correctly?

**If segments are too coarse:** Add Google Cloud STT (Chirp 3) for transcription only. The schema and viewer don't change — only what populates `transcript_segments`. The pipeline becomes: STT for transcript, Gemini for equations, merge by timestamp.

---

## Pipeline design

### Input

YouTube URLs only for MVP. Gemini accepts YouTube URLs natively — no download or file hosting required.

MIT OpenCourseWare lectures on YouTube are the test corpus. Public, embed-enabled, covering physics, math, chemistry, biology — ideal for testing across conditions.

### Video processing parameters

| Parameter | Value | Rationale |
|---|---|---|
| Resolution | Default (258 tok/frame) | Full resolution required — equation legibility depends on every pixel. Handwritten chalk on dark boards needs maximum detail. |
| Frame rate | 0.5 FPS | Equations persist on board for 30-120 seconds. One frame every 2 seconds captures every meaningful board state. |
| Audio | 32 tok/sec (fixed) | Not configurable. |

**Token budget for 60-min lecture at these settings:**

| Component | Tokens |
|---|---|
| Visual (0.5 FPS × 258 tok × 3600s / 2) | ~464,400 |
| Audio (32 tok × 3600s) | ~115,200 |
| Prompt + output headroom | ~90,000 |
| **Total** | **~670,000** |
| **Context window** | **1,048,576** |
| **Headroom** | **~380,000** |

90-min lectures at these settings: ~870K tokens. Fits, but tight (~130K headroom). If headroom is insufficient, drop to 0.33 FPS (one frame every 3 seconds) — still more than enough for equation capture.

### Pass 1: Transcript extraction

Prompt Gemini to transcribe speech only. Key prompt requirements:
- Output as structured JSON array of segments
- Each segment: text, start_time, end_time
- Sentence-level granularity (explicitly request this)
- Preserve technical terminology exactly as spoken
- Do not describe visual content — speech transcription only

### Pass 2: Equation extraction

Prompt Gemini to extract equations visible in the video. Key prompt requirements:
- Output as structured JSON array of equations
- Each equation: LaTeX string, natural language description, discussed_start, discussed_end, confidence score
- **"Discussed" timestamps**: the time range when the equation is being actively written or verbally discussed — not the full duration it's visible on the board
- LaTeX notation specifically (not MathML, not plain text)
- Natural language description for each equation (serves as alt-text and future embedding input)
- Confidence score (0-1)

### Pass 2 context: deduplication via context carry-forward

For videos that require chunking (>90 min or output token issues), pass accumulated equations into subsequent chunk prompts:

```
Previously extracted equations from earlier segments:
[
  {"id": "eq_001", "latex": "E = mc^2", "discussed_start": "03:24", "discussed_end": "05:10", "description": "mass-energy equivalence"},
  ...
]

Continue extracting from this segment. If an equation from the list above appears again and is being re-discussed, create a new entry with the new discussed timestamps and the same LaTeX. Assign new IDs starting from eq_NNN.
```

This keeps dedup context small (~1-2K tokens for 30 equations) while giving the model enough information to avoid re-extracting identical equations.

### Merge step

After both passes complete, link equations to transcript segments using discussed-timestamp overlap:

```sql
INSERT INTO segment_equations (segment_id, equation_id)
SELECT s.id, e.id
FROM transcript_segments s
JOIN equations e ON e.video_id = s.video_id
  AND e.timestamp_start < s.timestamp_end
  AND e.timestamp_end > s.timestamp_start
WHERE s.video_id = $1;
```

Because equations use "discussed" timestamps (not "visible on board" timestamps), this merge produces tight, accurate links — equations only appear in transcript segments where they're actually being talked about.

### Prompt versioning

Store a version string (e.g., `v0.1`, `v0.2`) with each extraction. Both raw API responses (`raw_gemini_transcript_json`, `raw_gemini_equations_json`) are stored on the video record for reprocessing.

---

## Schema

```
videos table:
  id                       UUID PK
  title                    TEXT
  youtube_url              TEXT
  duration                 FLOAT
  status                   ENUM (queued, processing, complete, failed)
  raw_gemini_transcript_json  JSONB
  raw_gemini_equations_json   JSONB
  transcript_prompt_version   TEXT
  equations_prompt_version    TEXT
  created_at               TIMESTAMP

  INDEXES:
    idx_videos_status ON (status)

equations table:
  id                UUID PK
  video_id          UUID FK → videos.id
  latex_string      TEXT
  description       TEXT (natural language — alt-text + future embeddings)
  timestamp_start   FLOAT (seconds) — when actively discussed, NOT full visible duration
  timestamp_end     FLOAT (seconds)
  confidence        FLOAT
  frame_snapshot_url TEXT (nullable)
  created_at        TIMESTAMP

  INDEXES:
    idx_equations_video_id         ON (video_id)
    idx_equations_video_timestamps ON (video_id, timestamp_start, timestamp_end)

transcript_segments table:
  id                UUID PK
  video_id          UUID FK → videos.id
  text              TEXT
  timestamp_start   FLOAT
  timestamp_end     FLOAT
  created_at        TIMESTAMP

  INDEXES:
    idx_segments_video_id         ON (video_id)
    idx_segments_video_timestamps ON (video_id, timestamp_start, timestamp_end)

segment_equations table (join table):
  segment_id   UUID FK → transcript_segments.id  ON DELETE CASCADE
  equation_id  UUID FK → equations.id            ON DELETE CASCADE
  position     INT (nullable — ordering hint for multiple equations in one segment)
  PRIMARY KEY (segment_id, equation_id)

  INDEXES:
    idx_seg_eq_equation_id ON (equation_id)
```

### Schema notes

- **`timestamp_start/end` on equations = "actively discussed" window.** This is the tight window when the professor is writing or verbally referencing the equation. The merge step uses these for linking. If we later want "visible on board" tracking (e.g., a sidebar showing all currently-visible equations), add `visible_start/visible_end` columns — not needed for MVP.

- **Two raw JSON columns + two prompt versions on videos.** Since we run two Gemini passes, store each response and prompt version independently. Allows reprocessing either pass without re-running the other.

- **`youtube_url` replaces `source_url`.** MVP is YouTube-only. Rename back to `source_url` when supporting direct file upload.

- **Equations that get re-discussed** (e.g., professor writes F=ma at minute 5, references it again at minute 35) become separate equation rows with the same `latex_string` but different timestamps. Simple, slightly denormalized, correct for the merge. Dedup/grouping is a Phase 2 concern (similarity clustering).

- **Future columns (don't add yet):**
  - `equations.visible_start/visible_end` → for "on-screen" sidebar display
  - `equations.embedding` → VECTOR(768) for semantic search (Phase 2)
  - `equations.cluster_id` → UUID FK for similarity grouping (Phase 2)
  - `equations.verified` → BOOLEAN for review workflow (Phase 1)

---

## Viewer

### Stack

| Concern | Tool |
|---|---|
| Framework | Next.js 15 + TypeScript |
| Styling | Tailwind CSS |
| Equation rendering | KaTeX (outputs MathML alongside visual — screen readers get it for free) |
| Video player | YouTube iframe API |
| Deployment | Vercel (when ready) |

### Layout

Single page per video at `/video/[id]`:
- **Main area:** YouTube embedded player (iframe API)
- **Sidebar (or below on mobile):** Scrolling transcript with inline rendered equations
- Click any timestamp → `player.seekTo(seconds)`
- As video plays, poll `player.getCurrentTime()` → auto-scroll transcript, highlight active segment
- Equations render inline via KaTeX where they appear in context

### Key viewer query

```sql
SELECT s.*, e.latex_string, e.description, e.confidence
FROM transcript_segments s
LEFT JOIN segment_equations se ON se.segment_id = s.id
LEFT JOIN equations e ON e.id = se.equation_id
WHERE s.video_id = $1
ORDER BY s.timestamp_start, se.position;
```

### Accessibility (bake in from day 1)

- KaTeX outputs MathML alongside visual rendering — screen readers parse it natively
- Equation `description` field provides alt-text fallback
- Transcript is real DOM text, not canvas/image
- Keyboard navigable (arrow keys to move between segments)
- WCAG 2.1 AA color contrast
- ARIA labels on interactive elements
- Semantic HTML (proper heading hierarchy, landmark regions)

---

## Cost estimate

| Scenario | Cost per lecture |
|---|---|
| 60 min, 0.5 FPS, default res, Flash standard | ~$0.35 |
| 60 min, 0.5 FPS, default res, Flash batch API | ~$0.18 |
| 90 min, 0.33 FPS, default res, Flash standard | ~$0.40 |
| 90 min, 0.33 FPS, default res, Flash batch API | ~$0.20 |

Second pass (equations) with context caching: ~90% input token discount → adds ~$0.02-0.04.

---

## Monorepo structure

```
chalkboard/
├── pipeline/              # Python — Gemini extraction, processing
│   ├── pyproject.toml
│   ├── alembic/           # DB migrations
│   │   └── versions/
│   ├── src/
│   │   ├── models/        # SQLAlchemy models
│   │   ├── extraction/    # Gemini pipeline logic (transcript + equations)
│   │   ├── processing/    # Merge step
│   │   └── api/           # FastAPI routes (when needed)
│   └── scripts/           # CLI entry points (process_video.py, etc.)
├── viewer/                # Next.js — web viewer
│   ├── package.json
│   ├── app/
│   │   └── video/
│   │       └── [id]/
│   │           └── page.tsx
│   ├── components/
│   └── lib/
├── docker-compose.yml     # Postgres
├── .env.example
└── README.md
```

### Key dependencies

```
# pipeline/pyproject.toml
python = "^3.12"
google-generativeai = "^0.8"
sqlalchemy = "^2.0"
alembic = "^1.14"
psycopg2-binary = "^2.9"
python-dotenv = "^1.0"
fastapi = "^0.115"       # when needed
uvicorn = "^0.34"        # when needed

# viewer/package.json
next = "^15"
react = "^19"
katex = "^0.16"
typescript = "^5"
tailwindcss = "^4"
```

Note: No ffmpeg, no google-cloud-speech, no yt-dlp. Gemini handles video input natively via YouTube URL.

---

## MVP demo flow

1. Run `python pipeline/scripts/process_video.py <youtube-url>` locally
2. Pipeline sends URL to Gemini (pass 1: transcript, pass 2: equations)
3. Merge step links equations to segments by discussed-timestamp overlap
4. Everything lands in Postgres in a single transaction
5. Send viewer link to disability office / professor
6. They see their lecture with equations beautifully rendered in the transcript

**No upload UI needed.** You are the upload UI.

---

## Open questions

1. **Gemini transcript granularity** — The single biggest unknown. Must validate segment-level timestamps on real lectures before committing to Gemini-only transcription. If too coarse, add Google Cloud STT for transcription.

2. **Gemini equation extraction accuracy** — No published benchmark. Run 5-10 lectures across conditions (clean slides, messy whiteboard, mixed, different STEM fields) and manually grade before building beyond the pipeline.

3. **"Discussed" vs "visible" timestamp quality** — Can Gemini reliably distinguish between "actively being discussed" and "just sitting on the board"? Test this explicitly.

4. **YouTube 8-hour daily processing cap** — Free tier limitation. Paid tier reportedly has no limit. Confirm before scaling.

5. **Structured output at long output lengths** — Report flags degradation before the 65K hard limit. Two-pass strategy mitigates but monitor for empty responses.

---

## What NOT to build (MVP)

- User auth
- File upload UI (you are the upload UI)
- Billing/payments
- Mobile app (responsive web is fine)
- Real-time captioning (batch only)
- Custom LLM fine-tuning (prompt engineering first)
- Direct file upload support (YouTube-only for MVP)
- "Visible on board" equation tracking (discussed timestamps only)
- VTT/SRT export (Phase 1)
- Equation review/edit UI (Phase 1)
