# Prompt Determinism — Design

**Date:** 2026-04-23
**Status:** Approved for implementation planning
**Scope:** All Gemini system/user prompts in `pipeline/`

## Problem

Same video, re-run through the pipeline, produces structurally different outputs between runs:

- **Equations**: sometimes one derivation step per entry, sometimes multiple steps merged into one `latex` field. Counts vary by 50%+ between runs on the same video.
- **Tables**: free-form `description` with no guidance on how to verbalize a table for an audio-description format.
- **Code**: the LLM has total freedom over how to organize long snippets — what to summarize, what to transcribe verbatim, how to describe nested structure.
- **Text** (slides / written board text): currently outputs as a prose blob even when the source is structurally a heading + bulleted list. Visually hard for sighted users; semantically unhelpful for screen readers, which are *happiest* with semantic structure (`<ul>`, `<h3>`, `<p>`).
- **Diagrams, charts, other**: free-form descriptions with no house style.

The LaTeX rendering is fine; the *shape* of the output varies. For students depending on this content for accessibility parity, inconsistent structure run-to-run is a reliability problem.

## Approach

Hybrid fix — schema changes where structure wins, prompt rules where prose is unavoidable.

- **Schema changes** for `table`, `code`, and `text` — bake determinism into the type system so Gemini cannot produce a blob.
- **Prompt rules + templates + examples** for `equation`, `diagram_description`, `chart_description`, `other` — these content types are fundamentally prose (spatial relationships, free-form descriptions), so structural fields would over-constrain. Deterministic *style* comes from explicit rules, fixed-order templates, and one good + one bad example.
- **Fix the v2 transcript drift**: `process_video_v2.py` currently uses a shortened inline prompt instead of the rich `TRANSCRIPT_USER_PROMPT` from `prompts.py`. Wire it up properly.
- **Light polish on topic_map**: move prompt into `prompts.py`, add title/description style rules, add a version constant.

## Schema Changes (`pipeline/src/extraction/schemas.py`)

### New `TextBlock` class

```python
class TextBlock(BaseModel):
    kind: Literal["heading", "paragraph", "bullet"] = Field(
        description="Block kind: heading (title on the slide), paragraph (running text), bullet (list item)"
    )
    text: str = Field(description="The text content, with inline $...$ for math")
    depth: int = Field(
        default=0,
        description="Nesting depth for bullets. 0 = top-level bullet, 1 = sub-bullet. Always 0 for heading/paragraph."
    )
```

### New fields on `VisualContentItem`

```python
# For text (new)
text_blocks: list[TextBlock] = Field(
    default_factory=list,
    description="Structured text blocks. Only for content_type 'text'."
)

# For table (new)
title: str = Field(
    default="",
    description="Table title/heading as written above it. Empty string if untitled. Only for content_type 'table'."
)
caption: str = Field(
    default="",
    description="ONE sentence stating what the table shows. Only for content_type 'table'."
)

# For code (new)
purpose: str = Field(
    default="",
    description="ONE sentence stating what the code does. Only for content_type 'code'."
)
structure: list[str] = Field(
    default_factory=list,
    description="Ordered list of high-level code blocks in the order they appear. Each item is one imperative phrase. Only for content_type 'code'."
)
```

### `content_type` description update

```python
content_type: str = Field(
    description="Type of visual content: equation, code, table, chart_description, diagram_description, text, or other"
)
```

Adds `other` as a valid value. No new field for `other` — it reuses `description`.

### Existing `description` field

Becomes unused for `table`, `code`, `text`. Kept in the schema with `default=""` for backward compatibility with old demo JSONs. Prompt instructs the model to leave it empty for these types.

Remains the primary content for `equation` (secondary alt-text), `diagram_description`, `chart_description`, and `other`.

## Prompt Rewrites (`pipeline/src/extraction/prompts.py`)

### `EQUATIONS_USER_PROMPT` — add granularity rule

Add a new section (after the confidence guidance) to `EQUATIONS_USER_PROMPT`:

> **Granularity: one written line = one entry.** If the professor writes `F = ma`, substitutes to get `F = 5 \cdot 2`, then simplifies to `F = 10`, that is THREE entries — never one. Never combine multiple lines into a compound `latex` string like `F = ma = 5 \cdot 2 = 10`. Each entry's `latex` field contains exactly what was on ONE line of the board. The `discussed_start` / `discussed_end` timestamps are for that one line.
>
> Good: three entries, `latex = "F = ma"`, `latex = "F = 5 \cdot 2"`, `latex = "F = 10"`.
> Bad: one entry, `latex = "F = ma = 5 \cdot 2 = 10"`.

Bump `EQUATIONS_PROMPT_VERSION` → `v0.4`.

### `VISUAL_CONTENT_USER_PROMPT` — full per-type rewrite

Replace the six existing type sections with seven tightened sections. Each section is deterministic on either structure (new schema fields) or fixed-order prose template.

**1. equation** — Same granularity rule as standalone equations prompt. One written line = one entry.

**2. text** —
> Fill `text_blocks` with one block per visually distinct unit: titles as `heading`, running sentences as `paragraph`, bulleted items as `bullet` (with `depth` for nesting).
> Transcribe every word VERBATIM inside each block.
> Inline math: wrap in `$...$` within the block's `text`.
> Leave `description` empty — `text_blocks` is the content.
> NO markdown in the `text` field. The block `kind` carries structure.

Example — a whiteboard showing *"Warm-Up"* heading, one question, three bullets:

```json
[
  {"kind": "heading",   "text": "Warm-Up", "depth": 0},
  {"kind": "paragraph", "text": "How would you know if any of these are true?", "depth": 0},
  {"kind": "bullet",    "text": "There are infinitely many primes", "depth": 0},
  {"kind": "bullet",    "text": "Every even $\\#>2$ is the sum of two primes", "depth": 0},
  {"kind": "bullet",    "text": "Your code never gets stuck in an infinite loop and always computes function", "depth": 0}
]
```

**3. diagram_description** —
> Begin the `description` with one sentence identifying the diagram: *"A {type} diagram of {subject}."*
> Then list elements in numbered form: *"Elements: (1) {element} — {position/relationship}. (2) {element} — {position/relationship}. …"*
> List every labeled element, bond, arrow, and annotation. Use inline `$...$` for symbols and labels.

**4. chart_description** —
> Format the `description` in this fixed order: *"A {chart type} showing {subject}. X-axis: {label} in {unit}, range {min} to {max}. Y-axis: {label} in {unit}, range {min} to {max}. Data: {trend or key values}."*
> If ranges aren't visible, write `range not labeled`. Never invent values.
> Use inline `$...$` for units and variable names.

**5. table** —
> Fill `title` with the heading as written above the table, or `""` if no title.
> Fill `headers` with exact column labels, in order.
> Fill `rows` with exact cell values, one list per row, in written order.
> Fill `caption` with ONE sentence stating what the table shows. Format: *"{Type} of {subject} across {categories}."* Examples: *"Comparison of boiling points across three solvents."* *"Truth table for the XOR operation on two inputs."*
> Leave `description` empty.
> Do NOT editorialize, summarize trends, or explain meaning in the caption — that belongs in the transcript.

**6. code** —
> Fill `code` with the snippet VERBATIM. Preserve every space, tab, newline, and symbol. Include every line, even for long snippets (50+ lines).
> Fill `language` with the language name in lowercase (`python`, `javascript`, `c`, `cpp`, `java`, `pseudocode`, etc.).
> Fill `purpose` with ONE sentence stating what the code does. Format: *"{Verb}s {object} using {method}."*
> Fill `structure` with an ordered list of imperative phrases, one per top-level block, in order of appearance. Example: `["Function signature taking n and threshold", "Input validation raising ValueError if n < 0", "For loop iterating over range(n)", "If-statement comparing element to threshold", "Return statement for matched element", "Return None fallback"]`.
> Leave `description` empty.

**7. other** —
> Use this ONLY when no other type fits. Do NOT use as a catch-all for ambiguous content — pick the closest primary type first. If a whiteboard sketch has math, it's `equation` or `diagram_description`. If a slide has bullet points, it's `text`. `other` is reserved for non-board content: photos of lab setups, screenshots, physical apparatus held up to the camera, maps, timelines.
> Fill `description` with this format: *"A {media type} showing {subject}. Contents: (1) {element}. (2) {element}. …"*

Bump `VISUAL_CONTENT_PROMPT_VERSION` → `v0.3`.

### `TRANSCRIPT_USER_PROMPT` — no text change

The transcript prompt at v0.3 is already tight. The fix is plumbing (see below).

### `TOPIC_MAP_PROMPT` — move and tighten

Move the inline prompt from `topic_map.py:78-105` into `prompts.py` as a new constant. Add these rules to the existing instructions:

> **Title style**: Title Case, no trailing period, ≤ 50 characters. Do not use phrases like "Introduction to" or "Overview of" — just the topic.
> **Description**: exactly one sentence, ≤ 20 words. Declarative, not a question.

Add `TOPIC_MAP_PROMPT_VERSION = "v0.2"` (currently unversioned → v0.2 to mark the first versioned release).

## Plumbing — v2 Transcript Drift

[`process_video_v2.py:170-206`](pipeline/scripts/process_video_v2.py:170) defines its own inline transcript prompt and uses a truncated one-liner as the system instruction. The rich v0.3 `TRANSCRIPT_USER_PROMPT` (deictic resolution, LaTeX examples, "no connector phrases") is imported as a version string only — never actually called. This means v2 has been running with a much weaker transcript prompt than intended.

### Fix

Update `extract_transcript_chunk` to match the pattern the function already uses for equations and visual content:

```python
def extract_transcript_chunk(client, url: str, start: float, end: float, context: str, ...):
    system = f"{TRANSCRIPT_SYSTEM_PROMPT}\n\n{context}"

    for attempt in range(3):
        try:
            vp = types.Part(...)  # unchanged
            response = client.models.generate_content(
                model=model,
                contents=types.Content(parts=[vp, types.Part(text=TRANSCRIPT_USER_PROMPT)]),
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    response_mime_type="application/json",
                    response_schema=SentenceListOutput,
                ),
            )
            ...
```

Delete the inline `prompt = f"""..."""` block. Add `TRANSCRIPT_SYSTEM_PROMPT` and `TRANSCRIPT_USER_PROMPT` to the imports at [`process_video_v2.py:36-41`](pipeline/scripts/process_video_v2.py:36).

No `TRANSCRIPT_PROMPT_VERSION` bump — the prompt text itself isn't changing; v2 starts actually using the existing v0.3 prompt.

## Viewer Changes (`viewer/components/GroupedEquations.tsx`)

Three render branches change. All changes are additive — fall back to `description` when new fields are empty so old demo JSONs keep rendering.

### 1. `text` block rendering

Replace the current `<RichText text={item.description} />` with a block renderer:

```tsx
item.contentType === "text" && item.textBlocks?.length ? (
  <TextBlocks blocks={item.textBlocks} />
) : item.contentType === "text" ? (
  // fallback for old JSONs
  <p className="..."><RichText text={item.description} /></p>
) : ...
```

New `TextBlocks` component groups consecutive `bullet` blocks into a single `<ul>`, handles nested `depth` via nested `<ul>`, renders `heading` as `<h3>`, `paragraph` as `<p>`. Uses `RichText` for each block's `text` to handle inline `$...$` math.

### 2. `code` block rendering

Render `purpose` as a caption above the `<pre>`, add a collapsible `<details>` for `structure`:

```tsx
item.contentType === "code" && item.code ? (
  <div>
    {item.language && <span className="language-badge">{item.language}</span>}
    {item.purpose && <p className="text-sm italic mt-1">{item.purpose}</p>}
    <pre className="..."><code>{item.code}</code></pre>
    {item.structure?.length ? (
      <details className="mt-1">
        <summary className="text-xs cursor-pointer">Structure</summary>
        <ol className="list-decimal ml-5 text-xs">
          {item.structure.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      </details>
    ) : null}
  </div>
) : ...
```

### 3. `table` block rendering

Add `title` as a small heading above the table. Replace the existing `description` paragraph below with `caption`:

```tsx
item.contentType === "table" && item.headers && item.rows ? (
  <div className="overflow-x-auto">
    {item.title && <h4 className="text-sm font-semibold mb-1">{item.title}</h4>}
    <table>...</table>
    <p className="text-xs mt-1">{item.caption || item.description}</p>  {/* fallback */}
  </div>
) : ...
```

### 4. `other` block rendering

Add a case that renders like the chart/diagram case (description as main content, no badge beyond the type label).

## Version Bumps

| Constant | Before | After |
|---|---|---|
| `TRANSCRIPT_PROMPT_VERSION` | v0.3 | v0.3 *(no prompt text change — only plumbing)* |
| `EQUATIONS_PROMPT_VERSION` | v0.3 | v0.4 *(granularity rule added)* |
| `VISUAL_CONTENT_PROMPT_VERSION` | v0.2 | v0.3 *(full per-type rewrite, +other type, +schema fields)* |
| `TOPIC_MAP_PROMPT_VERSION` | *(none)* | v0.2 |

## Validation

No unit tests — this is prompt engineering, not unit-testable.

1. Pick one reference video that currently produces visible variance. Candidates already in `viewer/public/demo/`: `iw72Yj_pJGs` (L'Hopital, 112 min Zoom — known problem child, documented in CLAUDE.md). User picks which.
2. Run `process_video_v2.py` 3 times back-to-back with the new prompts.
3. Compare the three demo JSONs:
   - Section count stability (should be identical — topic map is text-only, low variance already).
   - Equation granularity: per-line vs merged. Look for any `latex` field containing multiple `=` signs across different derivation steps.
   - Table field completeness: `title`, `caption`, `headers`, `rows` all populated; `description` empty.
   - Code field completeness: `purpose`, `structure`, `code`, `language` populated; `description` empty.
   - Text: `text_blocks` populated with correct `kind` values; `description` empty.
   - Diagram/chart template adherence: opening sentence matches template, elements enumerated.
4. Write a short note in `docs/decisions.md` under a new heading: "Prompt determinism v2 — before/after variance on {video}". Not a formal ADR, just a paragraph.

**Ship gate:** if variance is still egregious (same video produces 50 vs 120 equations), iterate on prompts before merging. If it's in the same ballpark (±10% counts, same format shape, same field fill rates), it's good.

## Out of Scope

- Retroactively reprocessing existing demo JSONs in `viewer/public/demo/`. Viewer fallbacks handle old shape.
- Renaming `description` across the codebase. Stays as-is, just unused for table/code/text going forward.
- Changing Gemini model, temperature, or FPS.
- Touching `pipeline/src/extraction/gemini.py` (v1 pipeline). Untouched.
- Structured fields for `diagram_description`, `chart_description`, `other` — these remain prose.
- Chart field splitting (`chart_type`/`x_axis`/`y_axis`/`data_summary`) — deferred; revisit if chart variance turns out to be real.

## File Manifest

Files to modify:
- `pipeline/src/extraction/schemas.py` — add `TextBlock`, add 6 fields to `VisualContentItem`, update `content_type` description.
- `pipeline/src/extraction/prompts.py` — rewrite `EQUATIONS_USER_PROMPT`, `VISUAL_CONTENT_USER_PROMPT`; add `TOPIC_MAP_PROMPT` and `TOPIC_MAP_PROMPT_VERSION`; bump version constants.
- `pipeline/src/extraction/topic_map.py` — import `TOPIC_MAP_PROMPT` from `prompts.py`, remove inline prompt string.
- `pipeline/scripts/process_video_v2.py` — add `TRANSCRIPT_SYSTEM_PROMPT`/`TRANSCRIPT_USER_PROMPT` imports; replace inline transcript prompt in `extract_transcript_chunk` with the standard system+user pattern.
- `viewer/components/GroupedEquations.tsx` — add `TextBlocks` renderer, update code/table branches, add `other` case.
- `docs/decisions.md` — append validation note after the three-run test.

Files not modified:
- `pipeline/src/extraction/gemini.py` (v1 pipeline).
- `pipeline/scripts/process_video.py` (v1 pipeline).
- Existing demo JSONs in `viewer/public/demo/`.
