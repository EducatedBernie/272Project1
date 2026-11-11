# On-demand cited study notes

**Goal:** A user explicitly generates a readable study chapter from a completed lecture extraction and can inspect each citation beside the video.

**Approved design:** This conversation's study chapter: editorial paper, topic navigation on the left, independent video/evidence on the right. Self-contained at the course prerequisite level. No automatic notes during extraction, no personal annotations, chat, model migration, or deployment.

**Architecture:** Reuse pipeline_runs and the existing worker with run_type=generate_notes. Add a nullable notes JSONB result and a partial unique index preventing concurrent/successful duplicate notes for a source extraction. Generate from source-run transcript and visual snapshots, validate model-selected IDs, and persist cited snapshots with the chapter. Exclude notes jobs from extraction selectors.

**Contract:** NotesDocument {version:1,title:string,overview:NoteBlock[],sections:{id:string,title:string,blocks:NoteBlock[]}[],sources:NoteSource[]}; NoteBlock {text:string,citations:string[]}; NoteSource {id:string,kind:'transcript'|'visual',start:number,end:number,text:string,visual?:VisualContent}. Source IDs are existing UUIDs; no model-generated timestamps. NotesJob {id,status,progress,notes:NotesDocument|null,error:string|null,created_at,source_run_id}. POST /api/notes {video_id,source_run_id} returns job; GET /api/notes/[id] returns sanitized public job. Reader /video/[id]/notes?run=<source_run_id> accepts initialJob and can enqueue, poll, retry failure, or show saved notes. Generation uses existing auth.

**Isolation:** New codex/cited-notes worktree based on committed main 439b316. Leave all dirty experiment files in the original checkout untouched. Use current available Gemini model for notes via NOTES_MODEL; no changes to extraction model defaults.

- [x] Backend: test citation validation, snapshot provenance and worker dispatch; implement generator, migration and job handling.
- [x] Reader: build accessible responsive editorial document, chapter navigation and source panel using existing math/visual/player components; add player entry link.
- [x] Integration: implement validated auth-protected enqueue with deduplication, public status, source-run page loading, and exclude notes from extraction lookups.
- [x] Verification: run Python/TypeScript tests, lint/build, local Postgres migration and request/worker/read loop with stubbed model, browser rendering and keyboard/citation checks; review diff.

## Verification evidence

- Isolated Postgres migration upgrade completed through 7ad831e4bc20.
- 75 Python notes/worker tests and 62 TypeScript tests (including actual PostgreSQL enqueue deduplication) pass; targeted lint and production build pass.
- A real user-button request using the bundled Advanced Algorithms lecture generated and saved six topics, 19 cited blocks, and 156 unique source snapshots. The initial live attempt exposed an SDK schema transport incompatibility; response_json_schema fixed it and a serialized-request regression now covers it.
- Browser checks: saved chapter after reload, source evidence, paused video seeking, topic navigation, keyboard citation focus/return, mobile evidence/return and no horizontal overflow at 391 CSS pixels.
- Review fixed legacy section runs mislabeled process (guard progress.scope) and reset independently scrolled evidence on a new citation.
- Content was spot-checked against saved source excerpts; this is not an exhaustive learning-quality or citation-support evaluation.
