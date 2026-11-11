# Archived throwaway scripts

Scripts in this directory were one-off experiments. They are kept (rather
than deleted) so a future engineer can replay the experiment by name
without reinventing the setup.

## measure_v040_misplacement.py

Baseline measurement of v0.4.0 prompt misplacement rate on DSC30 across
13 × 10-min windows. Established the metric and the comparison baseline
that the EXP1/2/3 scripts below were judged against. Result: 7.1%
misplacement under v0.4.0 vs 16.1% under v0.3.6 — the FIELD PLACEMENT
RULES + few-shot examples carried 56% of the eventual lift.

To re-run against a different prompt version, ensure
`VISUAL_CONTENT_PROMPT_VERSION` in `prompts.py` is set to the version
you want to measure, restore the script to `pipeline/scripts/`, and
execute. The script reads the live prompt constant — no per-version
modification needed.

## measure_v050_with_heal.py

End-to-end measurement of v0.5.0 prompt + describe-first + deterministic
healer on DSC30 across the same 13 × 10-min windows. Reports both
pre-heal and post-heal misplacement rates. **Result: 1.0% pre-heal,
0.0% post-heal** — the full pipeline reduced misplacement to zero on
the canary video. Final number cited in commit messages for the
describe-first work.

Same re-run pattern as `measure_v040_misplacement.py`; reads the live
prompt + healer modules, no per-version tweaks needed.

## exp1_rename_boardwriting.py / exp2_describe_first.py / exp3_text_collapse.py

Three A/B experiments testing different architectural levers against the
v0.4.0 baseline. Each ran on the same DSC30 video and 10-min windows.

| Variant | Misplacement | Verdict |
|---|---|---|
| EXP1 — rename `text_blocks` → `boardWriting` | 9.2% | Negative result; field name doesn't drive the prior |
| EXP2 — describe-first (`visual_observation` field emitted before `content_type`) | **4.4%** | **The lever — shipped as v0.5.0** |
| EXP3 — collapse text content to a single `body: str` field | 18.5% | Strict regression; bug just relocates |

EXP2's prompt language and field declaration order were lifted into
`pipeline/src/extraction/prompts.py` and `pipeline/src/extraction/schemas.py`
under prompt version v0.5.0 (commit e8ec531). The remaining ~4% post-prompt
misplacement is handled by the deterministic healer at
`pipeline/src/extraction/healer.py`.

## verify_discriminated_union*.py

Throwaway A/B test scripts that compared the current flat
`VisualContentExtractionOutput` schema against a Pydantic
discriminated-union variant on Gemini structured-output calls. Used to
empirically settle whether the schema redesign documented in KI-006 was
worth shipping. Result: discriminated schema causes 31% chunk-loss rate;
flat schema + describe-first prompt + deterministic healer handles the
bug class better.

- `verify_discriminated_union.py` — first-pass test on 5 short clips,
  inconclusive (bugs didn't fire on 5-minute samples).
- `verify_discriminated_union_v2.py` — full-video test (13 × 10-min
  windows on DSC30) with corrected scoring (validator hits per-item, not
  parse-rejection counts). This is the run cited in KI-006.
- `*_results.json` — raw outputs from those runs.

To re-run any of these, restore the script to `pipeline/scripts/`,
ensure `GEMINI_API_KEY` is set, and execute. Cost estimate: ~$0.50–$1
per full-video run on DSC30 at the time of writing (2026-04-30,
gemini-3-flash-preview pricing).
