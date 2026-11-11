# Evaluation Tracking

## Summary
- **MathSpeech dataset:** 89 videos, 1,101 equations
- **Evaluated (Pass 2 vs MathSpeech):** 5 / 89 videos
- **Full pipeline (Pass 1 + 2, in DB):** 5 videos (3 non-MathSpeech)
- **Model:** gemini-3-flash-preview (switched from gemini-2.5-flash on 2026-03-18)
- **Last eval result:** 94.3% recall (floor — some "misses" are ground truth errors)

## Full Pipeline Videos (in database)

| YouTube ID | Title | Segs | Eqs | Model | Notes |
|---|---|---|---|---|---|
| qyP1xZCB62E | MIT 8.02 — Electrostatic Energy, Capacitors (Walter Lewin) | 327 | 35 | 2.5-flash | Demo video. Reprocess with 3-flash recommended |
| NRbdymYpL9s | Silent Board Work Demo (Bernie) | 12 | 7 | 3-flash | All 1.0 confidence. Hero demo |
| kd0xTfdt6qw | Feynman — The Relation of Mathematics & Physics (1964) | 292 | 5 | 3-flash | Correct on angular momentum. 2.5 models failed |
| mrcRODAx-Vk | The Gaussian Integral — Trefor Bazett | 83 | 16 | 3-flash | All 1.0 confidence. 16 equations, full proof |
| JAf_aSIJryg | Partial Derivatives & Multivariable Calculus | 332 | 122 | 2.5-flash | Dense notation. Reprocess with 3-flash recommended |

## Eval Extractions (Pass 2 only, MathSpeech benchmark)

| YouTube ID | GT Equations | Extracted | Recall | Model | Notes |
|---|---|---|---|---|---|
| 8gGbViZjoRw | 5 | 11 | 100% | 2.5-flash | Perfect recall |
| YBajUR3EFSM | 10 | 39 | 100% | 2.5-flash | 2 "misses" were GT errors (case, brackets) |
| 4gJLEYc3p5w | 6 | 16 | 100% | 2.5-flash | After normalizer fix |
| XRkgBWbWvg4 | 20 | 58 | 95% | 2.5-flash | 1 miss was GT error |
| wOHrNt9ScYs | 12 | 37 | 83% | 2.5-flash | 2 misses were GT errors, rest normalizer gaps |

## Not Yet Evaluated (84 MathSpeech videos remaining)

Run with: `python eval/run_eval.py --extract "https://www.youtube.com/watch?v=VIDEO_ID"`

## Cost Estimates (Gemini 3 Flash)
- Pass 2 only (eval): ~$0.10-0.20 per video
- Full pipeline (Pass 1 + 2): ~$0.43 per 60-min lecture
- 10 more eval videos: ~$1.50
- All 89 MathSpeech (Pass 2 only): ~$15
- 30 lectures full pipeline: ~$13

## Key Findings
- **Confidence scoring works:** 0.8 was the only incorrect extraction (Feynman on 2.5-flash). All correct extractions scored 0.9+
- **Gemini 3 Flash > 2.5 Flash:** Both 3 Flash and 3 Pro correct on Feynman equation that 2.5 models got wrong
- **Ground truth has errors:** Multiple confirmed cases where visual extraction is more accurate than speech-based MathSpeech annotations (case, bracket style)
- **Normalizer matters:** Recall jumped from 66% to 94.3% with LaTeX normalization improvements (\frac→/, \exp→e^, case-insensitive)
