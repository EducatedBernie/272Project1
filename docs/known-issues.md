# Known Issues

Latent bugs and footguns. Fix before scaling.

KI-001 and KI-002 were resolved in the Railway deployment work (2026-04-14). See `pipeline/scripts/worker.py` — heartbeat now uses its own session, dispatch validates params up front and lets exceptions propagate.

---

## KI-003: Caption-download fails transiently with no root-cause visibility; no fallback path exists

**Status:** partial mitigation shipped (2026-04-17, PR #4 — diagnostic logging). Transient-failure trigger and architectural gap still open.

**First observed:** 2026-04-17. Friend queued `https://www.youtube.com/watch?v=-U1zn3z0_rY` and the Khan Academy lecture `https://www.youtube.com/watch?v=pkEiHZAtoro` within the same ~3-minute window. Both hard-crashed with:

```
File "/app/scripts/process_video_v2.py", line 117, in download_captions
    raise FileNotFoundError(f"Could not download captions for {url}")
```

The Khan URL succeeded on a plain dashboard Retry less than two hours later with no code changes live on the worker yet. So the failure was **transient, not a deterministic pipeline defect against those URLs.** See investigation below.

### Three problems stacked

1. **Debuggability** (mitigated by PR #4). `download_captions` called yt-dlp with `capture_output=True` and never read `returncode`, `stdout`, or `stderr`. The sibling `get_video_duration` used a bare `except: pass` that returned `0` on any failure. Both silently swallowed yt-dlp's real error, so the operator only saw a bare `FileNotFoundError`. PR #4 captures and logs the rc + stderr/stdout tails on failure and also plumbs the stderr tail into the raised exception message, so `pipeline_runs.error` (and the dashboard card) surfaces the real reason. This does not *fix* anything — it just stops hiding the evidence on the next recurrence.

2. **Transient trigger is still unknown.** Phase-1 investigation ruled out every persistent cause we could think of:
   - Not a yt-dlp version issue — identical `2026.03.17` on local and inside the container, and the container image was built the same day as the failures.
   - Not a proxy-dead issue — `YT_DLP_PROXY` (Webshare residential) works end-to-end through both my laptop and the live container.
   - Not a caption-language issue — plain `en` is listed and downloadable (`en-orig` exists but is not the only option).
   - Not a URL-parsing issue — the leading-hyphen video ID `-U1zn3z0_rY` doesn't confuse yt-dlp.
   - Not user/permission — succeeds inside the container as both `root` and the non-root `worker` user.
   - Not concurrency — the worker is single-threaded (`FOR UPDATE SKIP LOCKED`, no thread pool).
   - Not the 120s subprocess timeout — failures completed in ~3.5s, too fast.

   Remaining candidates, **ordered by plausibility given the ~3.5s fast-fail pattern and the two-hour self-heal**:
   - Webshare residential proxy temporarily handed the worker a YouTube-shadowbanned exit IP (proxy rotates; this is Webshare's documented behavior under load).
   - YouTube player-script rollout hiccup affecting the specific `android_vr` extractor path yt-dlp uses by default (yt-dlp is missing `curl_cffi` impersonation and a JS runtime in `Dockerfile.worker` — it warns but usually works; under load this might tip over).
   - Brief per-IP rate limit at YouTube's edge (matches the "multiple URLs affected in a narrow window, then recovered" pattern).

   Next occurrence will emit yt-dlp's actual rc + stderr via the PR #4 logging. Wait for that before picking a fix.

3. **Architecture: no fallback when captions are truly unavailable.** Even if (2) is diagnosed cleanly, the v2 pipeline still has no plan B for a video that legitimately has no auto-captions (private/age-gated/owner-disabled/YT hasn't generated them). YouTube captions are both the word-alignment clock (`word_align.py`) and the input to `topic_map.py`, so every downstream stage depends on them. The failure mode is "pipeline dies at step 2, operator has no route to recover."

### Fix path

Short-term, waiting on next occurrence:
- Read the rc + stderr captured by PR #4 on the next transient failure.
- Based on the actual error, either: (a) add bounded retry-with-backoff inside `download_captions`, (b) install `curl_cffi` + a JS runtime in `Dockerfile.worker`, (c) request a proxy rotation from Webshare, or (d) switch extractors / add fallback extractor flags to yt-dlp.

Medium-term (still waiting on a signal, but worth doing regardless):
- Map common yt-dlp error strings to structured `run.error` codes (`"no_captions_available"`, `"age_restricted"`, `"proxy_failed"`, `"rate_limited"`) so the dashboard card can show a human-readable reason.

Long-term (needs an ADR): decide what "caption-less video" means for the product. Three real options:
  1. **Explicitly reject** at enqueue time — fast yt-dlp `--list-subs` pre-check on the web side, tell the user *"this video has no auto-captions; YouTube hasn't generated them yet"* before the worker picks it up.
  2. **Chirp 3 / Whisper fallback** — run our own ASR when yt-dlp fails, use the resulting word-timed transcript as the clock. Adds cost + complexity + a second code path, but opens up every YouTube video.
  3. **Gemini-with-timestamps path** — ask Gemini for timestamped sentences directly (we deliberately turned this off in v2 because of 5-30s drift). Might be acceptable for short videos where drift is bounded.

Option 1 alone is probably the right MVP; option 2 is the real unlock but a project on its own. Tracked for the caption-strategy ADR when we pick one up.

---

## KI-004: Chirp docstrings and log messages say "Chirp 3" but we actually run Chirp 2

**Status:** open. Cosmetic / debuggability issue — no runtime impact.

The STT default was flipped to `chirp_2` because Chirp 3 silently returned 0 words on long files (see `docs/ROADMAP.md` "Chirp 2" bullet). The default lives at [pipeline/src/extraction/chirp.py:29](pipeline/src/extraction/chirp.py:29):

```python
STT_MODEL = os.getenv("CHALKBOARD_STT_MODEL", "chirp_2")
```

But the surrounding prose wasn't updated. Stale "Chirp 3" references that will mislead anyone reading logs, code, or docs:

- [pipeline/src/extraction/chirp.py](pipeline/src/extraction/chirp.py): module docstring (line 2), step comment (line 7), function docstrings (lines 73, 148), `logger.info` calls (lines 104, 121), error messages (lines 161, 179).
- [pipeline/scripts/process_video_v2.py](pipeline/scripts/process_video_v2.py): step-1 docstring (line 5), dashboard `stage=` label (line 716), `logger.info` (line 720).

### Why it matters

Debuggability. When someone greps logs for "Chirp 3" (e.g. chasing the 0-words regression recurrence) they'll find matches that describe the *old* behavior. When an operator sees `stage="Generating captions (Chirp 3)"` on the dashboard, they'll assume Chirp 3 is live and mis-diagnose any STT quality issue.

### Fix

Mechanical find-and-replace: "Chirp 3" → "Chirp 2" across `pipeline/src/extraction/chirp.py` and `pipeline/scripts/process_video_v2.py`. Leave the `CHALKBOARD_STT_MODEL` env var name alone (it's model-agnostic by design). While there, consider logging `STT_MODEL` verbatim instead of hard-coding the version name, so the next swap doesn't produce a KI-005.

---

## KI-005: Visual content `discussed_end` clips at section-chunk boundaries instead of tracking content lifetime

**Status:** open. Quality issue — content that genuinely persists across a topic-section boundary gets its end-time truncated to the chunk's `end_time`, producing a pile-up of items ending exactly on the boundary.

**First observed:** 2026-04-29 on `DSC30-Final-Review` (video `77d7341f-230c-4b8e-9ddf-c7ddd06ec064`, run `e5ac668c-71b5-494c-ac3f-ac8a5efa573d`). Section 2 ("Interface Implementation Logic") runs 9:43–15:28; section 3 ("Inheritance and Implementation Constraints") starts at 15:28. Eight visual content items — all of the running Java code example actively displayed across the boundary — have `timestamp_end` exactly at 928s (15:28), even though the content remained on screen well into section 3.

### Mechanism

Visual content is extracted per-section in parallel (`extract_visual_content_chunk` in `pipeline/scripts/process_video_v2.py`). Each Gemini call gets a hard `start_time`/`end_time` window for that section. The prompt asks Gemini to produce `discussed_start` / `discussed_end` per item. When content is still on-screen at the chunk's `end_time`, Gemini caps `discussed_end` at that boundary rather than tracking it forward — because, from that chunk's perspective, the content stops being visible at the chunk boundary.

Quantitatively for the run above: 10 / 319 items (3%) end exactly on a section boundary. **8 of those 10 pile up at the single 15:28 boundary** because that's where a long-lived code example happened to span. Other boundaries get 0–1 items each — the issue is *content-dependent*, not uniform.

### Why it matters

The viewer's "On Screen" panel uses `discussed_start <= currentTime <= discussed_end` to decide what's active. When end-times are clipped, items disappear from the panel at the section boundary even though the content is still visible on the actual video. For the DSC30 lecture, the entire Java code example correctly shows during 9:43–15:28 and then mysteriously vanishes from the focus panel at 15:29, even as the speaker continues discussing it. This will get worse on lectures where slide content persists across many section boundaries.

It also creates the cosmetic artifact the user noticed: multiple items with identical end-timestamps, indistinguishable from each other in the chip stack.

### Fix path

Three options, in order of effort:

1. **Cross-chunk merge pass.** Post-extraction, scan items whose `discussed_end` lands on a section boundary, then check if the next section has a near-identical item starting at the boundary. If yes, merge into one item spanning the union range. If no (content actually disappeared), leave it. ~half-day; doesn't change the prompt; works on existing data via a backfill script.

2. **Overlap the chunk windows.** Send each section to Gemini with a small lookahead (e.g., +30s into the next section). Gemini sees the boundary in context and emits more accurate `discussed_end`. Cost: marginal — 30s of extra video per chunk × N sections. Doesn't help items whose content runs more than 30s past the boundary.

3. **Equation-style word-alignment for visual content.** We already align *transcript* timestamps against YouTube captions for sub-second accuracy (see `word_align.py`). Visual content items currently inherit Gemini's raw timestamps, which is also why equations drift (see `docs/decisions.md`). A proper fix aligns visual content end-times against the transcript when the transcript references the item, so a code example referenced in section 3 inherits its end-time from the last transcript segment that mentions it. Days of work, biggest payoff, listed in `CLAUDE.md` § Future work as "Equation timestamp alignment".

Option 1 is the cheapest cleanup; option 3 is the real fix. For now, the viewer's defensive fallbacks render the content correctly, and the only user-visible artifact is the same-end-time pile-up.


## KI-006: Discriminated-union schema causes 31% chunk-loss rate (rejected)

**Status:** investigated and rejected. Documented here so a future "let's just make the schema strict" instinct doesn't re-litigate without re-running the test.

**Tested:** 2026-04-30 against the user-reported failure case (DSC30, https://youtu.be/2a6wXV_Nn9U?si=1Jspx26q_i07a3ZC) across 13 × 10-min windows, both flat schema (current) and a Pydantic discriminated union with `min_length=1` constraints on primary fields per variant. Throwaway script lived at `pipeline/scripts/verify_discriminated_union_v2.py` (since archived).

| Metric | Flat | Discriminated |
|---|---|---|
| Total items | 112 | 82 |
| Total broken items | 18 | 0 |
| Broken-item rate | 16.1% | 0.0% |
| **Chunks lost (chunk_survived=False)** | 0/13 | **4/13 (31%)** |

In the 9 surviving chunks, discriminated wins (82 items / 0 broken vs 72 items / 7 broken) — net +17 quality items. In the 4 lost chunks, discriminated produces 0 items vs flat's 40 items (32 useful, 8 broken). Net across the full video: discriminated trades **+17 quality items for −32 entire-content losses**. Strict regression.

### Mechanism

Gemini doesn't emit empty strings for `description`; it omits the field entirely when it can't extract content. Pydantic's `min_length=1` constraint becomes "Field required" → whole-chunk parse failure → production returns `[]` for that chunk. The strict schema isn't *causing* Gemini to behave worse; it's exposing behavior that flat silently absorbs via `Field(default="")`. Errors observed in v3 run:

- 70:00–80: `items.2.other.description Field required` (2 items) — chunk lost (flat had 7 items)
- 80:00–90: `items.15.chart_description.description Field required` — chunk lost (flat had 16 items, including the only chart in the video)
- 90:00–100: JSON output truncated mid-string after 235s (output token limit) — chunk lost (flat got 10 clean items)
- 100:00–110: `items.3.diagram_description.description Field required` — chunk lost (flat had 7 items)

### Why we shipped Layer 2 (validators + repair) instead

Empirical categorization of the 187 broken items in prod's DSC30 run (e5ac668c, 2026-04-29) found **95.2% are misplacement** (content correctly generated but routed to `textBlocks` instead of `description`/`code`/etc.), only 4.8% are perception failures. The text-only repair pass mechanically rewrites the dominant bug class at ~$0.0003 per item — substantially cheaper and more reliable than the schema redesign.

### Re-evaluate if

- Gemini API release notes mention discriminated-union improvements (decode-time field-routing rather than rejection)
- PR 2's repair rate drops below 90% for misplacement bugs in production over 30 days
- A quiet sprint with appetite for a 3–5 day schema migration

Re-run by reconstructing `verify_discriminated_union_v2.py` against the same DSC30 video and 10-min windows. If chunk_survived hits 13/13 with comparable item counts to flat, the schema redesign is back on the table.

### Adjacent: KI-007 — nested "describe-first-then-classify" schema as future research

A theoretically sound alternative is a nested schema where `visual_observation: str` (free-form, no constraints) precedes `content_type` and a discriminated `payload`. The "scratchpad before answer" pattern from Tam et al. on JSON-schema-constrained reasoning addresses dispatch quality. NOT in scope for this plan because (a) output token budget concern (10–20% more tokens per item, closer to truncation risk), (b) still suffers the omit-required-field failure mode at the payload level, (c) significant migration cost (schema, viewer types, eval baselines), (d) Task 2.9 prompt engineering targets the same mechanism more cheaply. Revisit if Task 2.9 + PR 2 repair don't move the bug rate below ~5% in production over 30 days.

### Update — 2026-05-01: LLM repair retired in favor of describe-first + deterministic healer

The Flash-Lite repair pass was replaced (commit e8ec531 + the PR that follows it) after empirical evidence showed a flat-schema reasoning lever moves more of the bug class than the LLM repair was solving:

| Variant | Misplacement (DSC30, 13×10min) |
|---|---|
| v0.3.6 (no FIELD PLACEMENT RULES) | 16.1% |
| v0.4.0 (FIELD PLACEMENT + few-shot) | 7.1% |
| EXP2 — describe-first (`visual_observation` field emitted before `content_type`) | **4.4%** |

The remaining ~4% misplacement under v0.5.0 is handled by a ~140-LOC deterministic healer (`pipeline/src/extraction/healer.py`) — pure if/else rules that move misplaced content to the correct field. No LLM call, no timeout, no retry, no failure mode beyond "rule didn't match."

The discriminated-union ruling above still stands: the chunk-loss mechanism (Gemini omitting fields under `min_length=1` constraints) is independent of this update, and a future "let's just make the schema strict" instinct must re-run `verify_discriminated_union_v2.py` against the same DSC30 baseline before being acted on.

KI-007's nested describe-first schema has been partially shipped via the flat `visual_observation` field (no nested payload, but the leading-scratchpad mechanism is in place). Revisit the full nested form only if a future bug class shows up that the flat field can't catch.
