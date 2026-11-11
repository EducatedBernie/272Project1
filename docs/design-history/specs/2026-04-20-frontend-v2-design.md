# Frontend v2 — Editorial Reframe + Viewer Redesign

## Context

The current splash page undersells what Chalkboard actually does. It pitches "captions that render equations" but the pipeline already extracts **diagrams as prose alt-text** and **pseudocode as structured code** ([GroupedEquations.tsx:54-61](../../../viewer/components/GroupedEquations.tsx)). Those capabilities are invisible on [(marketing)/page.tsx](../../../viewer/app/(marketing)/page.tsx). The typography is Arial — self-defeating for a math-rendering product. The floating "Schedule a conversation" pill in [(marketing)/layout.tsx](../../../viewer/app/(marketing)/layout.tsx) dominates the page. The viewer at [VideoViewer.tsx](../../../viewer/components/VideoViewer.tsx) uses a hard `width: 3/5` split that isn't mobile-friendly.

A designer produced [`Chalkboard Splash Review v2.html`](../../../../../../tmp/chalkboard-splash-design/chalkboard-design/project/Chalkboard%20Splash%20Review%20v2.html) proposing a category reframe ("lecture comprehension, not captioning") with warm-paper editorial styling. The user shared a separate screenshot of a viewer redesign with a left "focus card" + right grouped-list layout and sentence-level anchoring of visual content.

This spec covers both redesigns. **Desktop only. Mobile deferred.** Ships on a worktree branch so it's reversible.

## Scope

**In scope (desktop):**
- Splash page `(marketing)/page.tsx` — new above-the-fold per v2 design; below-fold restyled with new tokens
- Viewer `/video/[id]` — new focus-card + grouped-list layout per user's mock
- `DemoViewer` on landing — same viewer composition, shrunk
- Global palette + type stack (new tokens in `globals.css`, new fonts via `next/font`)
- Anchor heuristic: attach each visual (equation/diagram/code) to the segment playing when it first appeared

**Out of scope:**
- Mobile UX. We'll avoid horizontal scroll and overflow at 375px but won't design a mobile layout.
- New AI passes for segment-level visual association (the heuristic is enough).
- Rewriting FAQ/ValueProps/HowItThinks copy — just restyle.
- `/dashboard` and `/debug` routes — they should still render on new tokens without regressions, but no redesign.

## Design system

### Palette (replace `viewer/app/globals.css`)

```css
:root {
  --paper:     #f6f3ec;   /* warm off-white, chalkboard-adjacent */
  --paper-2:   #ece7dc;
  --ink:       #141414;
  --ink-2:     #2a2a2a;
  --chalk-bg:  #1a2620;   /* deep green-black slate */
  --chalk-bg-2:#0f1814;
  --chalk-fg:  #f0ebdf;
  --accent:    #d97a3d;   /* terracotta — handwritten feel */
  --accent-2:  #c25a1f;
  --rule:      #1a1a1a1f;
  --muted:     #6b6b68;

  /* compat mapping — existing components using old names keep working */
  --background:    var(--paper);
  --foreground:    var(--ink);
  --card:          #ffffff;
  --border:        var(--rule);
  --muted-fg:      var(--muted);
  --active:        color-mix(in srgb, var(--accent) 12%, #fff);
  --active-border: var(--accent);
}

.dark { /* keep dark mode; remap to same semantics with slate base */
  --paper: #0f1814;
  --paper-2: #1a2620;
  --ink: #f0ebdf;
  --ink-2: #d8d4c8;
  --chalk-bg: #0f1814;
  --chalk-bg-2: #050907;
  --chalk-fg: #f0ebdf;
  --accent: #d97a3d;
  --accent-2: #e08c55;
  --rule: #ffffff14;
  --muted: #a8a596;

  --background: var(--paper);
  --foreground: var(--ink);
  --card: var(--paper-2);
  --border: var(--rule);
  --muted-fg: var(--muted);
  --active: color-mix(in srgb, var(--accent) 18%, var(--paper-2));
  --active-border: var(--accent);
}
```

The compat mapping at the bottom means existing components that reference `--background` / `--foreground` / `--active-border` pick up the new palette without touching their source. We only rewrite components where the *layout* is changing.

### Fonts ([viewer/app/layout.tsx](../../../viewer/app/layout.tsx))

Replace Geist Sans/Mono with:
- **`Instrument_Serif`** — display, weight 400, italic enabled — exposed as `--font-serif`
- **`Inter`** — UI body — `--font-sans`
- **`JetBrains_Mono`** — captions, kickers, code blocks — `--font-mono`

Update body default to `font-family: var(--font-sans)` in `globals.css`.

### Scale

- Hero H1: `clamp(44px, 6.4vw, 88px)` Instrument Serif, line-height 0.98, balanced, max-width 16ch
- Section H2: `clamp(28px, 3.6vw, 44px)` Instrument Serif
- Body: 17px Inter, line-height 1.55
- Kicker/mono: 11px JetBrains Mono, letter-spacing 0.14em, uppercase
- Segment text (viewer focus card): 22–24px Instrument Serif

## Splash page

### New above-the-fold sequence

Replace hero + `TransformDiagram` in [(marketing)/page.tsx](../../../viewer/app/(marketing)/page.tsx) with:

1. **Kicker row**: terra dot + "Lecture comprehension for STEM · beta" (mono, muted)
2. **Hero H1**: `Everything on the board, <em>rendered.</em>` — italic accent color on "rendered"
3. **Hero sub**: "Chalkboard understands a lecture the way a prepared student does — **equations** typeset in LaTeX, **diagrams** described in plain English, **pseudocode** pulled off the board as real code. Not a transcript. A set of notes. ADA Title II-ready · WCAG 2.1 AA · MathML native."
4. **Hero actions**: Primary ink button "Book a 15-min demo →" + quiet secondary "or see a live demo ↓" (anchor-scrolls to `#demo`). Self-serve YouTube paste exists but is password-gated behind `/login` → `/dashboard`; user undecided on public exposure, so we don't surface it from the splash yet.
5. **TabbedProof** (new component)
6. **WhatLandsStrip** (new component) — paper-2 bg, 3-col inventory: `∫ Equations in LaTeX + MathML | △ Diagrams as prose alt-text | { } Pseudocode as real code blocks` + italic eq "one lecture, four kinds of notes"

### Nav ([(marketing)/layout.tsx](../../../viewer/app/(marketing)/layout.tsx))

- Brand left (∫ mark + "chalkboard" + muted "/ai")
- Right links: Product / Benchmarks / Compliance
- Inline CTA button: "Book a demo →" (ink bg, paper fg, rounded 8px)
- **Delete the floating CTA pill.** The `fixed bottom-6 right-6` anchor tag at lines 52-60 is removed entirely.

### TabbedProof component (new — `viewer/components/landing/TabbedProof.tsx`)

3-tab switcher:
- `∫ Equations` — active by default, meta: "LaTeX · MathML"
- `△ Diagrams` — meta: "described · alt-text"
- `{ } Pseudocode` — meta: "structured · copyable"

Each tab reveals a 2-column panel (`1.1fr 1fr`, gap 28px):
- **Left (board)**: rounded slate card with aspect-ratio 16:10 image + caption strip (lecture badge + italic quote)
- **Right (output card)**: paper card — kind chip ("EQUATION" / "DIAGRAM" / "PSEUDOCODE") + mono caption ("rendered from audio + chalk") + big render area + italic footer metadata

Panel contents (hardcoded on the splash — this is marketing copy, not user data). The vEB lecture *has* been processed and lives in the DB but hasn't been exported to `viewer/public/demo/`. Follow-up ticket: run `pipeline/scripts/export_demo_data.py` against the vEB video so a future iteration can wire the Pseudocode tab to a real demo selector. For now, static payload is fine.

| Tab | Board image | Quote | Output |
|---|---|---|---|
| Equations | YouTube thumb `kd0xTfdt6qw/maxresdefault` (Feynman Cornell '64) | "…the component of force at right angles…" | KaTeX display of `\ddot{A} = \dot{\vec{r}} \times \dot{\vec{r}} + \vec{r} \times \frac{\vec{F}}{m} = 0` |
| Diagrams | `veb-diagram.png` (vEB triangle board) | "Hand-drawn triangles, VEB_u = VEB_√u recursion" | Prose alt-text paragraph (see v2 HTML line 981-983 for copy) with inline KaTeX |
| Pseudocode | `veb-pseudocode.png` (`pred(V,x)` board) | "Handwritten predecessor query" | `<pre>` code block on slate bg with the `pred(V, x)` algorithm (see v2 HTML line 999-1005) |

Assets copied from design bundle to `viewer/public/landing/`:
- `veb-diagram.png` ← bundle `project/assets/veb-diagram.png`
- `veb-pseudocode.png` ← bundle `project/assets/veb-pseudocode.png`

Feynman thumbnail uses YouTube CDN directly (already works — `TransformDiagram.tsx` did the same at line 159).

Tab switching: client component, `useState` for active tab. No route change. `renderKatex()` on mount + on tab change for the equations panel.

### Compliance section (mount existing [ComplianceSection.tsx](../../../viewer/components/landing/ComplianceSection.tsx))

The nav adds a "Compliance" link; needs a dedicated anchor target. `ComplianceSection.tsx` already exists on disk but is not currently mounted in [(marketing)/page.tsx](../../../viewer/app/(marketing)/page.tsx). No new component needed — just import and render it between `HowItThinks` and `ValueProps`. Wrap the section in `<section id="compliance">` for anchor-scrolling from the nav.

Restyle pass on `ComplianceSection.tsx` itself:
- Italic serif section title ("Built for accessibility compliance")
- Card bg → `var(--card)`; border → `var(--border)`; headline → `var(--foreground)` (palette tokens already used)
- Add a mono caption beneath the grid: `WCAG 2.1 AA · SC 1.1.1 · SC 1.2.2 · SC 4.1.2`

### Below-the-fold (keep, restyle only)

Touch each component to replace hardcoded blues (`#3b82f6`, `#2563eb`, `#ef4444`) with terra/accent tokens. Structural layout unchanged:
- [DemoViewer.tsx](../../../viewer/components/landing/DemoViewer.tsx) — active-tab color, captions-panel red border, transcript active highlight
- [HowItThinks.tsx](../../../viewer/components/landing/HowItThinks.tsx) — card bg `var(--paper-2)` + terra accent on headings
- [ValueProps.tsx](../../../viewer/components/landing/ValueProps.tsx) — card bg white-on-paper-2
- [FAQ.tsx](../../../viewer/components/landing/FAQ.tsx) — muted bg on open state
- Footer — paper-2 bg, terra rule

### Delete

- `viewer/components/landing/TransformDiagram.tsx` — replaced by TabbedProof
- Floating CTA anchor in `(marketing)/layout.tsx:51-60`

## Viewer `/video/[id]`

Rewrite [VideoViewer.tsx](../../../viewer/components/VideoViewer.tsx) to a 2-column layout:

```
┌────────────────────────────────────────────────────────────┐
│ Topbar: [∫ chalkboard /ai]  [breadcrumb]  [stats]          │
├─────────────────────────────────────┬──────────────────────┤
│  FocusCard (left, ~58%)             │ SegmentList (right)  │
│  ┌──────────────────┐               │ §4 · Recursive …     │
│  │   video player   │               │ 28:21 Let me redraw  │
│  │                  │               │ 28:32 So each piece… │
│  └──────────────────┘               │   ∫ T(u)=T(√u)+O(1)  │
│  § section · kicker                 │ 28:42 So VEB of…     │
│  Currently playing · segment 142    │   △ vEB diagram      │
│  Large segment text …               │ 28:58 And the rec… │
│  Current visual: [render]           │   ∫ T(u)=O(log log u)│
│                                     │ §5 · Predecessor …   │
└─────────────────────────────────────┴──────────────────────┘
```

### FocusCard component (`viewer/components/viewer/FocusCard.tsx`)

Top: `VideoPlayer` (unchanged — keep [VideoPlayer.tsx](../../../viewer/components/VideoPlayer.tsx))

Below video:
- Section pill: `§N · {title}` italic serif
- Kicker: `CURRENTLY PLAYING · SEGMENT {id} · mm:ss – mm:ss` (mono, muted, with terra dot)
- **Segment text**: Instrument Serif 22-24px, leading 1.3. Render inline `$...$` LaTeX via KaTeX. The current `SegmentText`/`parseInlineLatex`/`InlineLatex` helpers are defined inline in [Transcript.tsx](../../../viewer/components/Transcript.tsx) (lines 7-64) and not exported — extract them to `viewer/lib/inline-latex.tsx` as a shared helper so both `FocusCard` and `SegmentList` (and any future consumer) can import them. No per-token keyword highlighting — the mock shows peach-highlighted `√u` tokens but that's a rendering artifact of the designer's mock, not a real feature.
- Current visual (if any): kind chip header + render
  - Equation → big KaTeX display
  - Diagram → prose alt-text (existing render in GroupedEquations)
  - Code → slate `<pre>` block
- If multiple visuals are active, show the most recent one (largest `start` ≤ currentTime)
- Two small buttons top-right of the visual card: `↓ alt-text` (scrolls to full text in right list) and `⤢ full view` (opens lightbox — deferred, make no-op)

### SegmentList component (`viewer/components/viewer/SegmentList.tsx`)

Replaces [Transcript.tsx](../../../viewer/components/Transcript.tsx) in the viewer context.

Structure (flat scroll, one list):
```
§ 4 · Recursive structure          ← section header (italic serif)
  28:21  Let me redraw this…       ← segment: timestamp (mono 11px) + text (sans 15px)
  28:32  So each of those pieces…
           ∫ T(u) = T(√u) + O(1)   ← anchored visual: kind chip + small render, inline
  28:42  So VEB of size u is…
           △ vEB recursion diagram ← diagram: kind chip + alt-text excerpt (2 lines, truncate)
  ...
§ 5 · Predecessor query
  31:04  OK so let me write out…
  ...
```

- Active segment: terra left-border (3px), paper-2 bg, text color ink
- Non-active: muted foreground, transparent bg
- Click segment → `onSeek(segment.start)`
- Auto-scroll active segment to 1/3 position (existing pattern from Transcript.tsx:86-97)
- Anchored visuals below each segment use a compact chip + excerpt; click chip → seeks to `visual.start`

### Anchoring heuristic (`viewer/lib/anchor.ts` — new)

```ts
export interface AnchoredSegment extends Segment {
  visuals: VisualContent[];
}

export function anchorVisualsToSegments(
  segments: Segment[],
  visuals: VisualContent[]
): AnchoredSegment[] {
  // Sort segments by start
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const anchored: AnchoredSegment[] = sorted.map((s) => ({ ...s, visuals: [] }));

  for (const v of visuals) {
    // Find segment whose [start, end] contains v.start
    let idx = anchored.findIndex((s) => s.start <= v.start && v.start <= s.end);
    // Fallback: nearest following segment
    if (idx === -1) idx = anchored.findIndex((s) => s.start >= v.start);
    // Fallback: last segment
    if (idx === -1) idx = anchored.length - 1;
    anchored[idx].visuals.push(v);
  }

  // Sort each segment's visuals by start
  for (const s of anchored) s.visuals.sort((a, b) => a.start - b.start);
  return anchored;
}
```

Called once at the server boundary in [(app)/video/[id]/page.tsx](../../../viewer/app/(app)/video/[id]/page.tsx) — attach to the segments array before passing to the viewer.

Equations and diagrams/code come from two existing DB queries ([lib/db.ts](../../../viewer/lib/db.ts) — `getTranscriptWithEquations`, `getVisualContent`). We merge them and pass the unified `VisualContent[]` through the heuristic.

### Topbar (new `ViewerTopbar.tsx`)

- Left: brand + "/" + course/title breadcrumb (truncate on narrow)
- Right: pill with duration + stats: `68 min | 37 eq · 6 dia · 4 code`. Counts computed from the `visuals` array.
- No share button (dropped — we'll add sharing later if the flow actually needs it).

### Delete / replace

- [VideoViewerWithRuns.tsx](../../../viewer/components/VideoViewerWithRuns.tsx) — rewrite internals to compose `ViewerTopbar` + `FocusCard` + `SegmentList`. Preserve existing `RunSelector`, `PipelineProgress`, reprocess/cancel buttons — those stay in the topbar area.
- [VideoViewer.tsx](../../../viewer/components/VideoViewer.tsx) — **delete**. No callers; dead code.
- [Transcript.tsx](../../../viewer/components/Transcript.tsx) — used by `DemoViewer`; gets replaced there too in this pass. After that, no callers — delete.
- `ActiveEquations.tsx` / `GroupedEquations.tsx` — no longer used by main viewer path; keep for `/debug` route compatibility.

## DemoViewer on landing

Rewrite [DemoViewer.tsx](../../../viewer/components/landing/DemoViewer.tsx) to use `FocusCard` + `SegmentList` in a shrunk 2-col layout. Keep the demo-tab bar at top (5 demos). Height: `70vh` max. Left col ~55%, right col ~45%. Same anchoring heuristic applied client-side on the loaded demo JSON.

**Keep the "Standard captions" vs "Chalkboard Transcript" split panel on the right column** for now (user undecided — revisit after A/B feel). Implementation: right column becomes a vertical stack — top 30% `AutoCaptionPanel` (existing, restyled), bottom 70% `SegmentList`. The contrast-in-place is still useful on the landing page even though the tabbed proof above carries the main reframe; duplication is the feature, not the bug, until the user decides otherwise.

## Worktree + branch

Implementation goes on a fresh worktree to keep main clean:

```bash
git fetch origin
git worktree add ../chalkboard-frontend-v2 -b frontend-v2 origin/main
cd ../chalkboard-frontend-v2
```

Work happens there. PR when ready. User can `git worktree remove` if they hate it.

## Files

**New:**
- `viewer/components/landing/TabbedProof.tsx`
- `viewer/components/landing/WhatLandsStrip.tsx`
- `viewer/components/viewer/FocusCard.tsx`
- `viewer/components/viewer/SegmentList.tsx`
- `viewer/components/viewer/ViewerTopbar.tsx`
- `viewer/lib/anchor.ts`
- `viewer/lib/inline-latex.tsx` (extracted from `Transcript.tsx`)
- `viewer/public/landing/veb-diagram.png` (from design bundle)
- `viewer/public/landing/veb-pseudocode.png` (from design bundle)

**Modified:**
- `viewer/app/layout.tsx` — swap fonts
- `viewer/app/globals.css` — palette tokens + body font
- `viewer/app/(marketing)/page.tsx` — new above-the-fold, mount existing `ComplianceSection` at `#compliance`
- `viewer/app/(marketing)/layout.tsx` — new nav (Product / Benchmarks / Compliance), delete floating CTA
- `viewer/app/(app)/video/[id]/page.tsx` — apply anchor heuristic, pass `AnchoredSegment[]` through
- `viewer/components/VideoViewerWithRuns.tsx` — rewrite composition to ViewerTopbar + FocusCard + SegmentList, preserve RunSelector/PipelineProgress/reprocess
- `viewer/components/landing/DemoViewer.tsx` — use new viewer components, keep split captions panel
- `viewer/components/landing/ComplianceSection.tsx` — minor token restyle, mount it
- `viewer/components/landing/HowItThinks.tsx` — restyle (tokens only)
- `viewer/components/landing/ValueProps.tsx` — restyle (tokens only)
- `viewer/components/landing/FAQ.tsx` — restyle (tokens only)
- `viewer/lib/types.ts` — add `AnchoredSegment` type

**Deleted:**
- `viewer/components/landing/TransformDiagram.tsx` (replaced by `TabbedProof`)
- `viewer/components/VideoViewer.tsx` (dead code — no callers)
- `viewer/components/Transcript.tsx` (migrated callers to `SegmentList`)

## Verification

- `cd viewer && npm install` (new font packages pulled by next/font)
- `npm run typecheck` clean
- `npm run build` clean
- `npm run dev`:
  - `/` loads, all three tabs switch and render KaTeX/prose/code
  - Below-fold sections visible, restyled, no Tailwind blue remnants
  - Hero has no floating CTA pill; inline CTA works
  - `/video/NRbdymYpL9s` loads with focus card + right list; visuals appear inline under the right segments
  - Pick a video with diagrams in DB (`ed_XR1BzuQs` or `lQ6FBA1HM3s`) — verify △ chip shows up, alt-text visible
  - `DemoViewer` — all 5 demo tabs load and render in new layout
  - `/dashboard` — still renders without error (palette compat map handles it)
  - `/video/.../debug` — still renders
- Lighthouse accessibility run on `/` — contrast ratios ≥ 4.5:1 for body text, ≥ 3:1 for large text
- No horizontal scroll at 1440px, 1920px, 1024px
- At 375px: no horizontal scroll (content may overflow gracefully or stack primitively — mobile design deferred)
- Take before/after screenshots at 1440px: `/`, `/video/NRbdymYpL9s`, `/dashboard`

## Known follow-ups (explicitly NOT in this work)

- Mobile-specific layouts (focus-only mode on phones, pull-up sheet for segment list)
- Variable auto-highlighting in segment text (currently only renders explicit `$...$` LaTeX)
- Full-view lightbox on visual cards
- Dark mode palette refinement (first pass maps `.dark` to slate/chalk; may need tuning after real use)
- Exporting the vEB lecture (`0JUN9aDxVmI`) from the DB to `viewer/public/demo/` so the Pseudocode tab can eventually link to a real demo selector rather than a static card
- Decision on public self-serve paste-a-YouTube-URL (currently password-gated via `/login` → `/dashboard`)
- Decision on whether to keep the "Standard captions" comparison panel in `DemoViewer` — kept for now, user to evaluate after seeing it live
