# Eval test set

A curated set of production videos used as a regression seatbelt for
prompt-version bumps to the visual-content extraction pipeline. Each
baseline is the output of `process_video_v2.py`'s extraction for one
(video, prompt_version) pair.

## Workflow

When you bump `VISUAL_CONTENT_PROMPT_VERSION` in `pipeline/src/extraction/prompts.py`:

1. Bump the version constant.
2. Run the eval against the OLD baselines:
   ```bash
   cd pipeline && source .venv/bin/activate
   python scripts/eval_runner.py
   ```
   - Exit 0: no regressions (all videos either improved or unchanged).
   - Exit 1: at least one video has a new validation rule firing or a
     suspicious count drop. Review the report; decide whether to revert
     the prompt or capture the new behavior as the baseline.
3. If you accept the new behavior, capture fresh baselines:
   ```bash
   python scripts/eval_runner.py --capture
   git add eval/baselines/*.json
   git commit -m "eval: capture baselines for prompt vX.Y.Z"
   ```

## Curating the test set

`test_videos.json` ships with one entry — the DSC30-Final-Review video
that triggered the user-reported bug on 2026-04-29. Before running the
eval seriously, expand to ~20 videos covering all seven content types.

To pick candidates from the prod DB:
```bash
railway link --service Postgres
eval "$(railway variables --kv | grep DATABASE_PUBLIC_URL | sed 's/^/export /')"
psql "$DATABASE_PUBLIC_URL" <<'SQL'
SELECT v.id, v.youtube_url, v.title, v.duration,
       pr.id AS run_id,
       (SELECT array_agg(DISTINCT content_type) FROM equations e WHERE e.run_id = pr.id) AS content_types
FROM videos v
JOIN pipeline_runs pr ON pr.video_id = v.id
WHERE pr.status = 'complete'
  AND v.duration > 0
  AND v.duration < 1800     -- under 30 min keeps eval cost bounded
ORDER BY v.created_at DESC
LIMIT 40;
SQL
```

Pick ~20 videos that:
- Cover each of the seven content_types at least twice
- Include at least 3 videos with known-bad items (DSC30, Lewin, etc.)
- Vary in length (5/10/15/20 min — avoid all-short or all-long bias)

Add each one to `test_videos.json` with `video_id`, `youtube_url`,
`title`, and `tags` (free-form labels for grouping — e.g. `["code",
"java", "known_bad:code_in_text_blocks"]`).

## What counts as a regression

Three signals fire a regression. Improvements are also tracked but
never block.

1. **New validator rules firing.** A video that didn't trip
   `code_in_text_blocks` (or `diagram_description_misplaced`, etc.) in
   the baseline now does. Direct catch for the misplacement bug class.

2. **Per-content_type count drops > 30%.** A prompt change that silently
   produces half as many equations on a known-good video is suspicious
   even if the surviving equations are individually clean. Threshold
   avoids false positives on Gemini's stochastic ±10–20% output drift.

3. **Total item count drops > 50%.** Catches chunk-level failure modes
   where any future schema or prompt change causes Gemini to return `[]`
   for a chunk that previously had content. (See KI-006 for the
   discriminated-union case study.)

What the diff intentionally does NOT flag: small count swings, content-text
edits, timestamp drift, or LaTeX-string differences. Those are normal
Gemini non-determinism and would produce false-positive alarms.

If you find yourself reading "X count dropped 35%" and shrugging because
it's within Gemini noise on this specific video, capture a fresh baseline
(`--capture`) to absorb the new floor. The eval is a *moving* baseline by
design.

## Cost

Each eval run extracts visual content from N videos at ~10 minutes
average each at 0.5 fps. Roughly $0.25–0.50 per video at current Gemini 3
Flash pricing — so 20 videos × $0.25 ≈ $5 per `--capture` pass. Bumping
to 30 fps or longer videos increases cost roughly linearly.

## Test-set rotation

Hand-picked test videos go stale. Bug classes we haven't seen yet (a
misclassification specific to a new lecture style) won't be in the set.
Rotate ~5 of the 20 videos every quarter, especially after any
user-reported issue lands a new failure mode. Newly-curated videos
should always include the recent issue's video.

The DSC30 video that triggered the 2026-04-29 user-visible failure is
the FIRST entry — it stays in the set as a regression-prevention canary.
