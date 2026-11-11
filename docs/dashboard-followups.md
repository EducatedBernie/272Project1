# Dashboard follow-ups

Scope carved out of the frontend-v2 dashboard redesign (2026-04-22). Phase 1 shipped the visual redesign with real data only. These items were in the design mock but were skipped because they need auth / schema / billing work that doesn't exist yet.

## Deferred

### Auth / session
- **User chip in topbar** (avatar + email). The design shows `B bernie@mit.edu`. We have no user model — the dashboard is password-gated via a single shared cookie (`DASHBOARD_PASSWORD`). Needs proper auth before we can personalize.
- **`Sign out` action.** No logout route exists. Easy fast follow-up: `POST /api/auth/logout` that clears the cookie + redirects to `/login`.
- **Nav links**: `Library` / `Runs` / `Settings`. None of those routes exist. "Library" would just be `#library` on the dashboard today. "Runs" is a full runs-history page. "Settings" is a whole area (API keys, institutional billing, prompt overrides).

### Schema
- **Dia + code counts in library cards.** The video card currently shows `eq` count only. The design wants `∫ 42 · △ 4 · { } 0`. Needs either a join onto `visual_content` in `/api/videos`, or a materialized count column on `videos`.
- **`★ Pinned` / `Favorites` filter.** No schema. Add a `pinned_at` column on `videos` or a join table. Low priority.
- **`Shared` filter.** No sharing model. Would need a `video_shares` table + public tokens. Feature work.

### Billing / usage
- **Compute usage meter** (`$4.62 / $12.00`, "resets in 8 days"). No billing data source. Would need either Gemini cost tracking aggregated per user, or a monthly cap system. Not planned.

### Queue UX
- **`Move up` on queued runs.** Worker does FIFO via `FOR UPDATE SKIP LOCKED`. No priority column. Add `priority INT` + order by.
- **`Transcribe audio →` fallback on failed `downloading_captions` runs.** Tracked as [KI-003](known-issues.md#ki-003-caption-download-fails-transiently-with-no-root-cause-visibility-no-fallback-path-exists) in known-issues. Real work — Chirp/Whisper ASR fallback.

### Mobile
- Dashboard is desktop-only in Phase 1 (same as the splash refactor). Stacking works, but the in-progress rows and library grid aren't optimized for narrow screens.

## Already landed (Phase 1, frontend-v2 branch)

- New topbar with brand + breadcrumb (no user chip, no nav links yet)
- Hero + dual-input intake card (YouTube URL + drop zone)
- In-progress section with per-run stage tracker + section bar
- Failed-run error box (read-only — no retry / no audio fallback)
- Library grid with real video cards (eq count only)
- Right rail with `This month` stats (derivable: lectures count, runtime total, equations total, avg run time)
- Static `Tip` card with content keyed to real product capability
