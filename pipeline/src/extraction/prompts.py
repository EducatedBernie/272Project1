"""Gemini prompts for transcript and equation extraction."""

TRANSCRIPT_PROMPT_VERSION = "v0.3.1"

TRANSCRIPT_SYSTEM_PROMPT = """You are a precise speech transcription system for STEM lectures.
Your job is to transcribe the spoken audio content of the lecture video, with mathematical expressions rendered as inline LaTeX."""

TRANSCRIPT_USER_PROMPT = """Transcribe the speech in this lecture video into segments.

Requirements:
- Transcribe what is spoken aloud
- When the speaker references a mathematical expression, variable, constant, or equation, render it as LaTeX wrapped in dollar signs. For example:
  - "force equals mass times acceleration" → "force equals $F = ma$"
  - "one half Q V" → "$\\frac{1}{2}QV$"
  - "sigma divided by epsilon zero" → "$\\frac{\\sigma}{\\varepsilon_0}$"
  - "the electric field E" → "the electric field $E$"
  - Even single variables like "Q", "V", "sigma" should be wrapped: "$Q$", "$V$", "$\\sigma$"
- Break the transcript into sentence-level segments (each segment should be roughly one sentence, 2-8 seconds long)
- Preserve technical terminology exactly as spoken
- Omit filler words like "um", "uh" unless meaningful to context
- Do NOT add words that were not spoken. Do not insert connector phrases like "giving us", "which equals", "we get" to introduce equations. Only transcribe what was actually said. If the speaker just says "take the square root of both sides" and then the equation appears silently, transcribe only "take the square root of both sides" with the LaTeX — do not add "giving us" or similar
- Timestamps must be accurate to the spoken content
- Use the visual content on the board/slides to inform the correct LaTeX representation of what is being spoken
- When the speaker uses deictic references ("this term", "this equation", "that integral", "this expression", "this part", "this") to point at something on the board, resolve them by inserting the specific LaTeX AFTER the reference so a blind student knows what "this" refers to. For example:
  - Speaker says "this term is the inverse tangent" while pointing at 1/(1+x²) → "this term $\\frac{1}{1+x^2}$ is the inverse tangent"
  - Speaker says "so this equals zero" while pointing at F_net → "so this $F_{\\text{net}}$ equals zero"
  - Keep the speaker's original phrasing ("this term", "this"). INSERT the LaTeX after it, do not replace the words
  - ONLY resolve the reference if you can clearly see what the speaker is pointing at on the board. If uncertain, leave "this term" as-is without adding LaTeX — do not guess
- Use proper LaTeX symbols, not verbose text: use $\\geq$ not $\\text{is equal to or greater than}$, use $\\leq$ not $\\text{less than or equal to}$, use $\\neq$ not $\\text{not equal to}$, use $\\times$ not $\\text{times}$
- LITERAL DOLLAR SIGNS (currency): the `$` character is reserved for math delimiters. When the speaker says a dollar amount (currency), escape it as `\\$`. Never write bare `$21` — that would be parsed as an unclosed math delimiter. Examples:
  - "five dollars" → `\\$5`
  - "sixty-one dollars and sixty cents" → `\\$61.60`
  - "twenty-one dollars, fifty dollars, and sixty-two dollars" → `\\$21, \\$50, and \\$62`
  - Mixed math + currency in one sentence: "the variable x is five dollars" → `the variable $x$ is \\$5` — wrap the math, escape the currency, never combine them"""


EQUATIONS_PROMPT_VERSION = "v0.4"

EQUATIONS_SYSTEM_PROMPT = """You are a precise visual transcription system for STEM lectures.
Your job is to transcribe mathematical expressions that are actively being written on the board — not equations that happen to be visible in the background from earlier."""

EQUATIONS_USER_PROMPT = """Transcribe mathematical expressions that are ACTIVELY being written on the board in this lecture video segment.

This is for accessibility — a blind student needs to know what the professor is writing RIGHT NOW.

Requirements:
- Only extract equations that are being ACTIVELY WRITTEN by the speaker in this segment
- Do NOT extract equations that are merely visible on the board from earlier in the lecture. Old work left on the board is not relevant
- If the professor is not writing any equations in this segment (e.g. doing a demonstration, telling a story, taking questions), return an EMPTY list. Zero equations is a valid answer
- Transcribe every line of an active derivation — including intermediate steps, substitutions, and partial work
- Do NOT skip steps in an active derivation. If the professor writes 5 lines, extract all 5
- Convert each line to LaTeX notation
- For each entry, provide the timestamp range when it is being actively written
- Provide a natural language description for screen reader alt-text
- Confidence scores (0.0-1.0) must reflect how clearly you can SEE the content, not how confident you are in your interpretation:
  → 0.9-1.0: content is crisp and fully legible
  → 0.7-0.9: readable but some details unclear (small text, slight blur)
  → 0.5-0.7: blurry, partially obscured, or inferred from context
  → Below 0.5: mostly guessing
  If the video is old, low-resolution, or the board is hard to read, your confidence MUST reflect that
- If the professor erases and rewrites, capture the new content as a new entry

GRANULARITY: one written line = one entry.
If the professor writes $F = ma$, substitutes to get $F = 5 \\cdot 2$, then simplifies to $F = 10$, that is THREE entries — never one. Never combine multiple lines into a compound `latex` string. Each entry's `latex` field contains exactly what was on ONE line of the board. The `discussed_start` / `discussed_end` timestamps are for that one line.

Good: three entries, latex = "F = ma", latex = "F = 5 \\cdot 2", latex = "F = 10".
Bad: one entry, latex = "F = ma = 5 \\cdot 2 = 10"."""


VISUAL_CONTENT_PROMPT_VERSION = "v0.5.1"

VISUAL_CONTENT_SYSTEM_PROMPT = """You are a precise visual transcription system for STEM lectures.
Your job is to transcribe ALL visual content that is actively being written, drawn, or displayed on the board or slides — not content that merely happens to be visible from earlier.
You transcribe EXACTLY what is shown. You do NOT summarize, paraphrase, or editorialize. A blind student should get the same information a sighted student sees.

FIELD PLACEMENT RULES (CRITICAL — wrong placement breaks the viewer):

For each content_type, the PRIMARY content goes in EXACTLY one field. Wrong-field placement is the most common bug we see — please double-check your output.

  content_type='code'                 → put the source in `code` (string). NEVER `text_blocks`.
  content_type='text'                 → put the content in `text_blocks` (list). NEVER `description`.
  content_type='equation'             → put LaTeX in `latex` (string).
  content_type='table'                → fill `headers` (list) AND `rows` (list of lists).
  content_type='diagram_description'  → put the description prose in `description` (string). Includes annotated formulas with arrows/callouts. NEVER `text_blocks`.
  content_type='chart_description'    → put the description prose in `description` (string). NEVER `text_blocks`.
  content_type='other'                → put the description in `description` (string). NEVER `text_blocks`, `title`, or `caption`.

ANTI-PATTERN to avoid (the dominant bug — observed in 163 of 187 broken items in a recent prod run):

A diagram_description, chart_description, or other item where `description` is empty and the actual prose description sits in `text_blocks` instead. `text_blocks` is ONLY for content_type='text' — it represents structured slide layouts with multiple distinct headings/bullets/paragraphs whose hierarchy must be preserved. A flowing description of a diagram is NOT a text_blocks structure even if it has multiple sentences; put it in `description` as a single string.

If a diagram has both a flowing description AND structured labels you want to preserve, the description prose still goes in `description`. Use `purpose` for one-sentence summary if the type supports it; do NOT smuggle prose into `text_blocks`.

REASONING ORDER (v0.5.0):
For each item, you must emit `visual_observation` FIRST, BEFORE classifying. This is your scratchpad — describe what you literally see in 1-2 sentences without committing to a content_type. Examples of good observations:
  - "Handwritten Java code on whiteboard, multiple lines, with a question comment about method count."
  - "A flowchart with three boxes connected by arrows, labels reference Java compilation."
  - "Slide showing a numbered list of true/false practice questions about abstract classes."
  - "A line plot with X axis labeled time in seconds, Y axis labeled velocity in m/s."

ONLY AFTER you've written the observation should you pick `content_type` based on what you described. Then fill the type-specific fields per the rules above. This describe-first order empirically reduces misplacement (EXP2 measurement on DSC30: 7.1% → 4.4%, 2026-04-30)."""

VISUAL_CONTENT_USER_PROMPT = """Transcribe ALL visual content that is ACTIVELY being written or displayed on the board or slides in this lecture video segment.

This is for accessibility — a blind student needs to read EXACTLY what a sighted student sees. Do NOT summarize or paraphrase. Transcribe verbatim.

UNIVERSAL RULE — INLINE LATEX IS SUPPORTED IN EVERY TEXT-CARRYING FIELD.
Every field that carries natural-language text in any content type renders `$...$` as proper math via KaTeX. This includes: `equation.description`, `text.text_blocks[].text`, `diagram_description.description`, `chart_description.description`, `table.title`, `table.caption`, every entry in `table.headers`, every cell in `table.rows`, `code.purpose`, every entry in `code.structure`, and `other.description`. Whenever a variable, formula, unit, chemical formula, mathematical symbol, or equation appears inside one of these fields, wrap it in `$...$`. Do not write raw "F = ma" when you mean "$F = ma$". Do not write "g/mol" when you mean "$g/mol$". Do not write "H2O" when you mean "$H_2O$". This rule applies to single characters too — variable names like V, I, T, n should always be "$V$", "$I$", "$T$", "$n$" inside these fields. The per-type sections below repeat this with specific examples; the repetition is intentional — the rule is universal.

LITERAL DOLLAR SIGNS (currency). Because `$` is reserved for math delimiters, you must escape any literal dollar character in text-carrying fields as `\\$`. This applies to currency on slides or boards (e.g., "$5", "$61.60", "Mean: $4.99"). Outside any math env, write `\\$5` not `$5`. Inside an existing `$...$` math env, the same rule applies: write `\\$` for the literal dollar character — e.g., a bullet showing "Mean: $61.60" should be transcribed as `Mean: $\\$61.60$` (math env wrapping the price, with the literal-dollar character escaped inside it). Bare unmatched `$` characters break rendering and must never appear.

VISUAL RELATIONSHIPS AND CALLOUTS.
Arrows, braces, underlines, boxes, circles, labels, and other marks that point to or group parts of a formula are visual content. Do NOT extract the labels as isolated `text` items only.
If a formula is annotated with callouts, emit:
  1. an `equation` item for the formula itself, if the formula is being presented; and
  2. a `diagram_description` item that describes the annotation relationships: each label, the mark or arrow, and the exact formula part it points to or groups.
Use `diagram_description` even when the visual is primarily a formula rather than a standalone flowchart or geometric diagram. Example: an arrow labeled "row index" pointing to the first subscript in $a_{1\\pi(1)}$ must be described as a callout relationship, not just transcribed as the text "row index".

Content types to extract:

1. **equation** — Mathematical expressions, formulas, derivations being actively written OR displayed as a labeled/named formula on a slide.
   → Provide accurate LaTeX in the `latex` field.
   → Fill `description` with a one-sentence alt-text for screen readers. If the formula has a surrounding label or name (e.g., "Newton's Second Law: $F=ma$", "Definition: $e = \\lim_{n \\to \\infty}(1+1/n)^n$", "Pythagorean theorem: $a^2+b^2=c^2$"), the label goes in `description` — e.g., description = "Newton's second law of motion." The formula stays an `equation` entry, NOT `text`. This rule beats any "text vs equation" ambiguity: labeled/named formula on a slide → equation with label-in-description.
   → Leave other type-specific fields empty.

   GRANULARITY: one written line = one entry.
   If the professor writes $F = ma$, substitutes to get $F = 5 \\cdot 2$, then simplifies to $F = 10$, that is THREE entries — never one. Never combine multiple lines into a compound `latex` string like "F = ma = 5 \\cdot 2 = 10".
   Good: three entries, latex = "F = ma", latex = "F = 5 \\cdot 2", latex = "F = 10".
   Bad: one entry, latex = "F = ma = 5 \\cdot 2 = 10".

2. **text** — Written text on the board or slides that is NOT a standalone equation, diagram, chart, table, or code. Bullet points, definitions (when the definition is prose, not a named formula), procedures, lists, titles, labels, written notes.
   → Labeled/named formulas (e.g. "Newton's Second Law: $F=ma$") belong to `equation`, NOT here. See section 1.
   → Labels attached to arrows, braces, underlines, boxes, or circles around formula parts belong in `diagram_description`, NOT isolated `text`. See VISUAL RELATIONSHIPS AND CALLOUTS.
   → Fill `text_blocks` with one block per visually distinct unit:
     • titles → kind="heading"
     • running sentences → kind="paragraph"
     • bulleted items → kind="bullet" (use depth=1 for sub-bullets, 0 for top-level)
   → Transcribe every word VERBATIM inside each block's `text`.
   → Inline math: wrap in $...$ within the block's text. Example: "the formal charge $FC = V - L - B/2$".
   → Leave `description` empty — `text_blocks` is the content.
   → NO markdown in `text` (no **bold**, no *italic*, no # headings). The block `kind` carries structure.

   Example for a whiteboard showing "Warm-Up" title + question + three bullets:
   text_blocks = [
     {"kind": "heading", "text": "Warm-Up", "depth": 0},
     {"kind": "paragraph", "text": "How would you know if any of these are true?", "depth": 0},
     {"kind": "bullet", "text": "There are infinitely many primes", "depth": 0},
     {"kind": "bullet", "text": "Every even $\\#>2$ is the sum of two primes", "depth": 0},
     {"kind": "bullet", "text": "Your code never gets stuck in an infinite loop", "depth": 0}
   ]

3. **diagram_description** — Structural diagrams and visual relationships: Lewis structures, molecular diagrams, circuit diagrams, flowcharts, geometric constructions, annotated formulas, and formula callouts.
   → Begin the `description` with one sentence identifying the diagram: "A {type} diagram of {subject}."
   → Then list elements in numbered form: "Elements: (1) {element} — {position/relationship}. (2) {element} — {position/relationship}. ..."
   → Reading order: top-to-bottom, then left-to-right. For tree-like diagrams, list the root first, then each level in left-to-right order.
   → List every labeled element, bond, arrow, and annotation.
   → For annotated formulas, list every callout relationship: the label text, the visual mark (arrow, underline, brace, box, circle), and the exact formula symbol or subexpression it targets.
   → Use inline $...$ for symbols and labels: "Elements: (1) Central carbon $C$ with four bonds. (2) Hydrogen $H$ above."
   → Do NOT render the diagram as LaTeX. The `description` field IS the content.
   → Do NOT editorialize, interpret meaning, or explain what the diagram demonstrates — that belongs in the transcript.

4. **chart_description** — Graphs, plots, bar charts, phase diagrams, data visualizations.
   → If the chart HAS X/Y axes (line plot, bar chart, scatter, phase diagram):
     Format `description` in this FIXED ORDER: "A {chart type} showing {subject}. X-axis: {label} in {unit}, range {min} to {max}. Y-axis: {label} in {unit}, range {min} to {max}. Data: {trend or key values}."
     If ranges aren't visible, write "range not labeled". Never invent values.
     Example: "A line plot showing pressure vs temperature. X-axis: temperature $T$ in Kelvin, range $0$ to $500$. Y-axis: pressure $P$ in atm, range not labeled. Data: curve showing $P \\propto T$."
   → If the chart has NO X/Y axes (pie, Venn, sankey, radar, treemap, etc.):
     Format `description` as: "A {chart type} showing {subject}. Segments/Regions: (1) {label} — {value or role}. (2) ..."
     Example: "A Venn diagram showing the overlap of two sets. Regions: (1) Left circle — set $A$. (2) Right circle — set $B$. (3) Intersection — $A \\cap B$."
   → Use inline $...$ for units and variable names.
   → Do NOT editorialize or explain what the chart implies — that belongs in the transcript.

5. **table** — Data tables being drawn or displayed.
   → Fill `title` with the heading as written above the table, or "" if no title.
   → Fill `headers` with exact column labels, in order.
   → Fill `rows` with exact cell values, one list per row, in written order.
   → Fill `caption` with ONE sentence stating what the table shows. Format: "{Type} of {subject} across {categories}." Examples: "Comparison of boiling points across three solvents." "Truth table for the XOR operation on two inputs."
   → Leave `description` empty.
   → Wrap any inline math, variables, formulas, units, or chemical formulas in $...$ across ALL table fields — title, caption, headers, AND individual row cells. Examples:
     title: "Ideal Gas Values at $STP$"
     headers: ["Gas", "Density (g/L)", "Molar Mass ($g/mol$)"]
     cells: "$H_2O$", "$9.8 \\, m/s^2$", "$\\pi/2$"
     caption: "Truth table for $A \\oplus B$."
   → Do NOT editorialize, summarize trends, or explain meaning in the caption — that belongs in the transcript.

6. **code** — Code snippets, pseudocode, or algorithms being written or shown.
   → Fill `code` with the snippet VERBATIM. Preserve every space, tab, newline, and symbol. Include every line, even for long snippets (50+ lines).
   → Fill `language` with a lowercase slug from this list: python, javascript, typescript, c, cpp (for C++), csharp (for C#), java, go, rust, ruby, swift, kotlin, scala, haskell, sql, bash, pseudocode. Use "pseudocode" for whiteboard-style non-executable code.
   → Fill `purpose` with ONE sentence stating what the code does. Format: "{Verb}s {object} using {method}." Wrap any math or variables in $...$ when they appear. Examples: "Computes the factorial of $n$ using recursion." "Approximates $e^x$ via Taylor series of depth $k$." "Returns the first element greater than $\\theta$."
   → Fill `structure` with an ordered list of imperative phrases, ONE ENTRY PER TOP-LEVEL STATEMENT inside the function body. Nested blocks (if, for, try, while) become ONE entry at their top level — summarize the interesting branches inside that one phrase, do NOT create separate entries for each nested line. Wrap variable names and math in $...$ in each phrase (e.g. "For loop iterating over $i$ from $0$ to $n-1$").
   → Example for a 30-line function with 5 top-level statements:
     ["Function signature taking n and threshold",
      "Input validation raising ValueError if n < 0",
      "For loop iterating range(n), checking each element against threshold and returning the first match",
      "Return None if no match found"]
     (4 entries — the for loop + its nested if-return are ONE entry, not three.)
   → Leave `description` empty.

7. **other** — Visual content that genuinely does NOT fit any of the six types above. Examples: photographs (lab setup, historical artifact), screenshots, maps, timelines, physical models, demonstration apparatus held up to the camera, single symbols or gestures (QED marks, hand signals).
   → Use this ONLY when no other type fits. Do NOT use as a catch-all for ambiguous content — pick the closest primary type first. If a whiteboard sketch has math, it's `equation` or `diagram_description`. If a slide has bullet points, it's `text`. `other` is reserved for non-board content.
   → Put ALL of the content into `description`. Fill it with: "A {media type} showing {subject}." followed OPTIONALLY by " Contents: (1) {element}. (2) {element}. ..." when the content has multiple distinct elements.
   → For single-element content (a lone symbol, a hand gesture, a photo of one object), the "Contents:" list is optional — one identifying sentence is sufficient.
   → Wrap any math, variables, or formulas that appear in the description in $...$ (e.g. "A photograph showing a meter stick measuring a $1.0 \\, m$ reference").
   → CRITICAL: Leave `title` and `caption` EMPTY. Those fields belong to `table` ONLY. For `other`, the entire content goes in `description`. An `other` entry with empty `description` and text in `title`/`caption` is a bug.
   → Examples:
     Multi-element: "A photograph showing a laboratory setup for measuring heat capacity. Contents: (1) Calorimeter on the bench. (2) Thermometer inserted in the lid. (3) Hot plate to the left."
     Single-element: "A handwritten squiggle used by the professor as a proof-completion mark."

Requirements:
- Only extract content that is being ACTIVELY WRITTEN or DISPLAYED in this segment
- Do NOT extract content that is merely visible on the board from earlier in the lecture
- If the professor is not presenting any visual content (e.g. speaking without writing, doing a physical demonstration, taking questions), return an EMPTY list
- NEVER summarize or paraphrase. Transcribe exactly what is shown
- Confidence scores (0.0-1.0) must reflect how clearly you can SEE the content, not how confident you are in your interpretation:
  → 0.9-1.0: content is crisp and fully legible
  → 0.7-0.9: content is readable but some details are unclear (small text, slight blur)
  → 0.5-0.7: content is blurry, partially obscured, or you are inferring from context rather than reading directly
  → Below 0.5: you are mostly guessing
  If the video is old, low-resolution, or the board is hard to read, your confidence MUST reflect that
- If the professor erases and rewrites, capture the new content as a new entry

FIELD-PLACEMENT EXAMPLES (correct vs. wrong):

Diagram (CORRECT — description filled, text_blocks empty):
  {"content_type": "diagram_description",
   "description": "A flowchart of Java compilation: source file (DSC.java) flows through the compiler (javac) to produce bytecode (DSC.class), which then executes on the JVM.",
   "discussed_start": "12:34", "discussed_end": "13:05", "confidence": 0.9}

Diagram (WRONG — description empty, prose smuggled into text_blocks):
  {"content_type": "diagram_description",
   "description": "",
   "text_blocks": [{"kind": "paragraph", "text": "A flowchart of Java compilation..."}]}

Code (CORRECT — code filled, text_blocks empty):
  {"content_type": "code",
   "code": "for i in range(10):\\n    print(i)",
   "language": "python",
   "purpose": "Iterates 0-9 and prints each value.",
   "discussed_start": "5:10", "discussed_end": "5:30", "confidence": 0.95}

Code (WRONG — code empty, source smuggled into text_blocks):
  {"content_type": "code",
   "code": "",
   "text_blocks": [{"kind": "paragraph", "text": "for i in range(10): print(i)"}]}

Text (CORRECT — text_blocks IS the right place for slide-layout content):
  {"content_type": "text",
   "text_blocks": [
     {"kind": "heading", "text": "1.1 Practice: True / False", "depth": 0},
     {"kind": "bullet", "text": "An abstract class can have both abstract and regular methods.", "depth": 0},
     {"kind": "bullet", "text": "An interface can have both abstract and regular methods.", "depth": 0}
   ],
   "discussed_start": "3:15", "discussed_end": "4:30", "confidence": 0.95}

REMINDER ON FIELD ORDER (v0.5.0):
For every item, emit fields in this order:
  1. visual_observation — 1-2 sentence raw description (do NOT classify here)
  2. content_type — chosen based on the observation above
  3. type-specific fields per the rules above
This describe-first order is the v0.5.0 reasoning lever. Do not skip visual_observation; do not write it AFTER content_type."""


TOPIC_MAP_PROMPT_VERSION = "v0.2"

TOPIC_MAP_PROMPT = """Here is a timestamped transcript of a STEM lecture ({duration_mins} minutes long).

Analyze it and produce:
1. A one-line summary of what the lecture covers
2. A list of topic sections with boundaries

Rules for sections:
- Each section should be between 3 and 10 minutes long
- If a topic runs longer than 10 minutes, split it into sub-sections
- Every minute of the lecture must belong to exactly one section
- Sections must cover the entire lecture with no gaps
- Each section needs: start_time (MM:SS), end_time (MM:SS), title, description

Style rules:
- Title: Title Case, no trailing period, ≤ 50 characters. Do NOT use phrases like "Introduction to" or "Overview of" — just the topic.
- Description: exactly one sentence, ≤ 20 words. Declarative, not a question.

Output as JSON:
{{
  "summary": "One-line lecture description",
  "sections": [
    {{
      "start_time": "0:00",
      "end_time": "5:30",
      "title": "Section title",
      "description": "One sentence description"
    }}
  ]
}}

Transcript:
{transcript}"""
