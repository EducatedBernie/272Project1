# Investigating Outputs

Covers the **"user says this output looks weird"** workflow — different from
`CLAUDE.md` § Debug loop, which covers **failure** (Slack fires with a
traceback). Here the run succeeded but a viewer is displaying something that
looks wrong, incomplete, duplicated, or suspicious.

> **First question every investigation must answer:**
> Is the bad content absent from the **DB**, or present in the DB but wrong in
> the **viewer**? These are totally different bugs and the fix lives in a
> different repo-slice. Always check the DB first.

## Before you investigate — connecting to the Railway DB

The worker is on Railway and the DB ships with it. `DATABASE_URL` inside the
Railway services points at `postgres.railway.internal`, which is unreachable
from your laptop. You need `DATABASE_PUBLIC_URL` (routes through Railway's
TCP proxy, e.g. `nozomi.proxy.rlwy.net:40942`).

```bash
# One-time: link this repo to the Postgres service
railway link --project 7a7b8582-4d1f-435c-b035-214f5062a81f \
             --environment production --service Postgres

# Per-session: export the public URL
eval "$(railway variables --kv | grep DATABASE_PUBLIC_URL | sed 's/^/export /')"
export RAILWAY_DB_URL="$DATABASE_PUBLIC_URL"

# Verify
python -c "import os, psycopg2; psycopg2.connect(os.environ['RAILWAY_DB_URL']).close(); print('ok')"
```

`railway link` flips the CLI's current service, so re-link to `worker` when
you're done (`railway link ... --service worker`) if you want `railway logs`
to default to the worker again.

## The investigation loop

```
┌────────────────────────────────────────────────────────────────┐
│  0. User reports something weird in the viewer                 │
│  1. Grab the video URL → find the run → summarize the run      │
│  2. Is the content in the DB? (inspect_run.py --run)           │
│     ├─ YES  → viewer bug. Stop. Fix the renderer.              │
│     └─ NO   → pipeline/extraction bug. Continue.               │
│  3. Open /debug → Raw Calls for the section. Inspect Gemini's  │
│     literal prompt/response before replaying.                  │
│  4. Reprocess: full video, one section, or visual-only.        │
│  5. Compare before/after with --diff.                          │
└────────────────────────────────────────────────────────────────┘
```

## The helper: `pipeline/scripts/inspect_run.py`

Resolves the DB URL from `--db-url`, `$RAILWAY_DB_URL`, or `$DATABASE_URL`
(in that order).

```bash
cd pipeline && source .venv/bin/activate

# Step 1 — find runs for a video (accepts UUID, YouTube ID, or URL)
python scripts/inspect_run.py --video 66b6e463-fa57-4de9-9ef3-e6f28d3fa338
python scripts/inspect_run.py --video nkePsdYOzwg           # YouTube ID works
python scripts/inspect_run.py --video 'https://youtu.be/...' # URL works

# Step 2 — summarize one run (counts by content_type; flags empty items)
python scripts/inspect_run.py --run 31bca6d1-cffc-40c7-8917-fdca6846cec2

# Step 3 — dump items of one type in a time window (seconds)
python scripts/inspect_run.py --run <id> --type text --from 0 --to 600

# Step 4 — dump one item's full row + metadata as JSON
python scripts/inspect_run.py --item db4242dd-74b0-43e4-a64b-d8b1f0d975b3

# Step 5 — compare two runs on the same video (item counts per content_type)
python scripts/inspect_run.py --diff <run_a> <run_b>
```

### Reading the `--run` summary

The critical line is the final block — **"items with empty description AND
empty latex_string"**. When `metadata_keys` is non-empty for those rows
(e.g. `['textBlocks']`, `['code']`, `['rows', 'headers']`), the pipeline
extracted the content correctly and the viewer is failing to render it. **That
is a viewer bug, not a pipeline bug.**

When `metadata_keys` is empty too, the row is genuinely empty — that's the
pipeline / Gemini problem to dig into.

## Raw Gemini call logs

New v2 runs persist forensic Gemini call logs for every Gemini attempt:

- Topic map call
- Per-section transcript chunk calls
- Per-section visual-content chunk calls
- Legacy per-section equation chunk calls when `visual_content_mode=False`
- Scoped section and visual-only reprocess calls

The database stores a compact manifest on `pipeline_runs.gemini_call_logs`.
Large raw blobs live privately in R2 under:

```text
debug/gemini-call-logs/{run_id}/{call_id}.json
```

Each manifest entry includes `kind`, `section_index`, `attempt`, status,
model/version, prompt version, section window, FPS, schema, token usage,
item count, blob size, R2 key, and any call/capture error. Each R2 blob
contains the rendered prompt/system instruction, video file URI or YouTube
URL, raw `response.text`, parsed response, usage metadata, and exception
details if the attempt failed.

### Using raw logs in `/debug`

`/video/<id>/debug` is an authenticated operator page. Regular
`/video/<id>` viewer links remain public, but `/debug` and raw-log fetches
require dashboard auth because raw logs include internal prompts and model
outputs.

In `/debug`:

1. Open **Raw Calls** to see all captured Gemini attempts grouped by topic
   map and section.
2. Open **Sections**, expand the suspect section, then use the **Raw Calls**
   sub-tab to inspect only transcript/visual calls for that section.
3. Click **Load raw blob** on a call only when needed. The page lazy-loads
   blobs through `/api/runs/<run_id>/gemini-call-logs/<call_id>` instead of
   shipping raw prompts/responses in the initial page payload.

`capture_status` meanings:

| Status | Meaning |
|---|---|
| `complete` | Every recorded attempt has an R2 blob. |
| `partial` | Some attempts have blobs, but at least one R2 write failed. |
| `failed` | Attempts were recorded, but all R2 writes failed. Student output may still be valid. |
| `unavailable` | No manifest exists. This is expected for runs created before raw-call logging shipped. |

Raw-log persistence is deliberately non-fatal. If R2 capture fails, the
pipeline continues, records `capture_error` in the manifest, and still saves
student-facing output.

### Important limitation for old runs

Runs created before `pipeline_runs.gemini_call_logs` existed cannot be
backfilled. The raw Gemini output was not persisted anywhere for those runs,
so the literal chunk JSON is unrecoverable. Use DB rows, transcripts, and a
scoped reprocess to infer behavior.

## Spotting viewer bugs vs. pipeline bugs

The `equations` table is the single source of truth for all visual content.
Each row has `description`, `latex_string`, and a JSONB `content_metadata`.
Different `content_type`s put their real content in different places:

| content_type          | Where the content lives                              |
|-----------------------|------------------------------------------------------|
| `equation`            | `latex_string` + `description` (alt-text)            |
| `text`                | `content_metadata.textBlocks` (NOT `description`)    |
| `code`                | `content_metadata.code` + `.language` + `.purpose`   |
| `table`               | `content_metadata.headers` + `.rows` + `.title`      |
| `diagram_description` | `description`                                        |
| `chart_description`   | `description`                                        |
| `other`               | `description`                                        |

So "empty description" is only a pipeline problem for the bottom three types.
For `text`/`code`/`table`, empty description is **expected** — the viewer has
to read the metadata.

Once you've confirmed the bug is in the viewer, open
[viewer/components/viewer/SegmentList.tsx](../viewer/components/viewer/SegmentList.tsx)
(in-transcript chips) and
[viewer/components/GroupedEquations.tsx](../viewer/components/GroupedEquations.tsx)
(right-rail panel) and check whether the affected `contentType` has a render
branch.

## Reprocessing

Three shapes, progressively narrower.

### Full reprocess — dashboard button (preferred)

The dashboard at `/video/[id]` has a **Reprocess** button in the top bar. It
enqueues a new `reprocess` run. Prefer this over the CLI — the worker already
runs the latest prompts and you get one-click comparison between runs.

### Full reprocess — CLI / local

```bash
cd pipeline && source .venv/bin/activate
python scripts/process_video_v2.py <youtube-url> --title "..." --db
```

Without `--db`, output goes to a demo JSON file only (safer for iteration).
See `process_video_v2.py` for `--run-id`, `--model`, `--fps` flags.

### One section only (cheap A/B on a single topic)

Use when you want to change a prompt and see the effect on one topic without
re-running the whole lecture. See `reprocess_section` in `process_video_v2.py`.

```python
from scripts.process_video_v2 import reprocess_section
reprocess_section(
    youtube_url="https://youtu.be/nkePsdYOzwg",
    video_id="66b6e463-...",
    run_id="<parent_run_id>",       # copies the section map from this run
    section_index=3,
    start_time=600.0, end_time=900.0,
    section_title="Even integer proof",
    context="<lecture summary + prev/next section info>",
)
```

### Visual-content only (skip transcript pass)

Use when only the equations/text/diagrams look wrong — the transcript is fine.
Saves ~half the Gemini cost.

```python
from scripts.process_video_v2 import reprocess_visual_content
reprocess_visual_content(
    youtube_url="https://youtu.be/nkePsdYOzwg",
    video_id="...", run_id="<parent>",
    section_index=None,  # None = all sections
)
```

### Replay a failed run

For runs that crashed (status=`failed`), use the existing
`pipeline/scripts/replay_run.py` — it reads the original run's params from the
DB and prints a ready-to-run local command. That flow is covered in
`CLAUDE.md` § Debug loop and stays unchanged.

## Cost & safety

- `inspect_run.py` is read-only. Safe to run anytime against prod.
- `process_video_v2.py` and its friends **write to the DB given `--db`**.
  Without `--db`, they only emit demo JSON. Dry runs by default.
- One full reprocess = one Gemini video pass per section × (transcript +
  visual). Cost tracks roughly with video length.
- `reprocess_section` and `reprocess_visual_content` are the cheap scalpels
  when you're iterating on a single prompt.

## When in doubt

1. Run `inspect_run.py --run <id>`. It answers most "is this the pipeline or
   the viewer" questions in one command.
2. Open `/video/<id>/debug` → **Raw Calls** for the suspect section. This
   answers "what did Gemini actually return?" for new runs.
3. Compare two runs with `--diff`. Large swings in per-type counts after a
   prompt tweak are usually the headline.
4. Before filing this under a pipeline issue, open the viewer's render
   branch for that `contentType` and check it exists.
