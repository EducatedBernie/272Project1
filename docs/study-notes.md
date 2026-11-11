# Study notes

After a full lecture extraction completes, open **Study notes** in the viewer and select **Generate notes with citations**. Generation requires the existing dashboard login. Reading a saved chapter and its citations uses the same public access as lecture playback.

This is a separate, explicit worker job (`generate_notes`). It never reruns video extraction or starts automatically. The chapter is saved on its own pipeline run and its URL pins the source extraction: `/video/<video-id>/notes?run=<source-run-id>`. Repeated UI requests reuse the current queued or completed chapter; an operator can enqueue a new generation without deleting the previous completed chapter. Scoped section/item extractions are not eligible for a full lecture chapter.

## Setup

Run `alembic upgrade head` from `pipeline/` against the intended database before running the updated worker/web app. The notes index prevents duplicate active jobs for the same extraction while preserving earlier completed chapters.

The worker needs `GEMINI_API_KEY`. `NOTES_MODEL` optionally selects the notes model (default `gemini-3.8-flash`); every notes writing and frame-selection request explicitly uses high thinking. This does not change video extraction defaults. Start the worker normally with `python scripts/worker.py`.

Each explicit generation produces two layers: Comprehensive for learning without watching, and Condensed for review. The saved topic map splits the transcript into roughly seven-minute calls; each call produces both layers for its own evidence window. The assembler retains every topic and validates citations against that window before saving. Calls have a 750,000-byte input bound and a 360-second timeout. Switching layers does not call AI. Older chapters remain readable. Oversized inputs, truncated output, empty content and unknown citation IDs fail explicitly.

## Sources and behavior

The generator can place selected source artifacts directly after a paragraph. Equations render from extracted LaTeX. Every other inline visual requires a crop of the original lecture frame: the worker samples up to three frames inside its saved interval, then asks Gemini to select a frame and normalized crop. That request contains only those frames and the artifact's locator description. It does not redraw content or receive the full chapter as context.

Each image retains the original JPEG, SHA-256, dimensions, requested frame time, model/prompt version and validated crop coordinates. The reader expands the crop by 10% and clamps it to frame edges. Inline notes show only the cropped frame; extracted metadata stays in the citation evidence panel. If no valid crop is available, the inline artifact is omitted while its citation and original evidence remain. Equations still use their extracted content. Frame times are requested seek times, not measured decoded presentation timestamps.

Frame acquisition requires `ffmpeg`, `ffprobe`, and a current `yt-dlp` (the worker image already installs these). YouTube frame source downloads try a compact AV1 stream directly before falling back to `YT_DLP_PROXY`; this avoids using residential bandwidth for multi-gigabyte source video when direct media works. Video bytes are cached under `~/.cache/chalkboard/notes-video/`. R2-configured workers publish content-addressed JPEGs through the existing storage helper. Local development without R2 writes ignored `viewer/public/notes-frames/` files; production requires complete R2 configuration because worker and web filesystems are separate. Boxing adds one bounded model request per distinct selected non-equation visual and is part of the explicitly requested notes job.

Every chapter paragraph includes model-selected source IDs. The application validates membership in the selected extraction and stores original source snapshots, including timestamps, alongside the chapter. Source snapshots remain readable if later extraction outputs change. Citation selection displays evidence; the separate Seek button moves the player. Topic navigation only moves the document.

The generation screen explains that notes depend on the first extraction, without independently re-checking the video. Low-confidence or unresolved cited visuals show a review notice; high confidence is not proof of correctness. Future prompts explicitly preserve uncertainty.

A valid citation guarantees a link to supplied evidence, not that the passage fully supports every generated claim or that the extraction itself is correct. Chapters are labeled AI-generated and should be evaluated with representative lectures before broader release.

## Checks

From `pipeline/`: `TEST_DATABASE_URL=<isolated-test-db> .venv/bin/python -m pytest tests/test_study_notes.py tests/test_notes_illustrations.py tests/test_worker.py -q`.

From `viewer/`: `npm test`, `npx tsc --noEmit`, and `npm run build`. To include the actual PostgreSQL enqueue/dedup/source-selection check, use `NOTES_TEST_DATABASE_URL=<migrated-isolated-test-db> npm test`. The Python fixtures recreate tables, so use a separate disposable database for that suite.

## Generation usage

New notes runs save Gemini usage metadata into `progress.usage`, including prompt, cached input, output and thinking tokens, requested/resolved model, and call count. Usage already incurred is retained even if content validation fails or the job is cancelled. The reader displays an estimated cost from the existing pricing helper. Older chapters without recorded usage display that fact; their exact cost cannot be reconstructed from chapter text alone.

## Player loading and preview limits

The player keeps a delayed YouTube API initialization alive instead of rejecting it after an arbitrary deadline. The UI distinguishes a delayed connection from genuine script/YouTube errors and preserves YouTube error codes. Queued citation seeks are applied when readiness arrives.

On 2026-09-15, approved CDP diagnostics isolated the Codex preview failure: the YouTube iframe document was rejected with `net::ERR_BLOCKED_BY_CLIENT`, `blockedReason: other`, while both API scripts returned HTTP 200. The request carried the correct localhost Referer. A plain iframe also failed; the same notes page loaded and played in Chrome guest mode. This matches the reported [Codex localhost iframe bug](https://github.com/openai/codex/issues/20307). No browser security settings or network interception were changed. The in-app browser issue remains external to Chalkboard; the delayed notice offers retry and a timestamped YouTube link instead of promising eventual connection.

The local chapter pilot added three original diagram crops with three successful real boxing calls (12,619 tokens). The existing pricing helper estimates this addition at $0.01512825 USD, and the saved chapter plus illustrations at $0.09387. These are token-based estimates, excluding storage/bandwidth and original lecture extraction. Crops and full-frame access were visually checked in the notes reader.
