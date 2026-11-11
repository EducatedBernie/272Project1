# Gemini diagram beautification: provider research

Researched 2026-09-21. Primary sources only. Documentation review; no paid requests or model quality benchmark was performed. Model availability and compatibility with this checkout's installed SDK still need a real smoke request before implementation is declared working.

## Recommendation

Treat the original frame as evidence and every beautified diagram as a derivative. For essential node-and-edge diagrams, trial **image understanding → constrained JSON → application-owned rendering** before adopting generic raster redraws. This makes labels and connections inspectable and gives consistent typography. For figures outside that narrow representation, retain the original crop initially. Raster image editing is the broader, faster-to-integrate alternative, but a visually convincing result is not evidence of faithful reconstruction.

This is an architectural inference, not a provider claim that JSON extraction is more accurate. Both methods can misunderstand the original. The representation controls what can be checked and rendered; it cannot establish truth.

## Supported API/model choices

| Model ID in current official docs | Input/output relevant here | Constraint |
| --- | --- | --- |
| `gemini-3.1-flash-image` | Text/images in; text/images out; also accepts video/PDF | Image editing model; no structured output or function calling. 131,072 input / 32,768 output token limits. |
| `gemini-3-pro-image` | Text/images in; text/images out | Image editing model; no structured output or function calling. 65,536 input / 32,768 output token limits. |
| `gemini-3.8-flash` | Text/images in; text out | Supports structured output; does not generate images. Thinking levels low/medium/high; `minimal` errors. |

Sources: [Flash Image model](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image), [Pro Image model](https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image), [3.8 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

Use stable image IDs above. The deprecation table lists June 25, 2026 shutdown dates for `gemini-3.1-flash-image-preview` and `gemini-3-pro-image-preview`. Some older developer-guide examples still reference them. The same table contains a stale replacement pointing from 2.5 Flash Image to the preview ID, so do not mechanically copy every migration example. [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations).

## Image editing contract

The current guide uses `client.interactions.create`: input is a text instruction plus original image content (`type: image`, `mime_type`, base64 `data` or URI). `response_format` can request an image, for example `type: image`, `mime_type: image/jpeg`, `aspect_ratio: 1:1`, `image_size: 1K`; multiple response formats allow text and image output. Flash Image supports 0.5K/1K/2K/4K; Pro supports 1K/2K/4K. Output images include SynthID. Multi-image references are supported, but this feature should send only the selected artifact's source frames. Disable search grounding: adding outside reference imagery conflicts with that scope. [Image generation guide](https://ai.google.dev/gemini-api/docs/image-generation).

The separate Generate Content guide still documents the existing `client.models.generate_content` surface, `response_modalities`, and image output parts (`inline_data`, or SDK `as_image()`). Those parts can include thought images; only persist the final non-thought image. This route may fit the existing worker better than an unrelated API migration. Confirm config names against the installed SDK rather than mixing Interactions `response_format` syntax into existing Generate Content calls. [Generate Content image guide](https://ai.google.dev/gemini-api/docs/generate-content/image-generation).

An image model's free-text response is not a structured validation result. Obtain JSON extraction or assessment in a separate request to a model supporting structured outputs.

## Structured reconstruction contract

Gemini's image-understanding guide demonstrates image input plus JSON schema output, including bounding boxes as `[ymin, xmin, ymax, xmax]` normalized to 0–1000. This supports the extraction building block; it does not document a complete educational-diagram conversion API. [Image understanding](https://ai.google.dev/gemini-api/docs/image-understanding).

The structured-output API supports a subset of JSON Schema, including objects, arrays, enums, required fields, numeric limits and array size limits. Google explicitly recommends validating returned values and handling semantically wrong but schema-valid outputs. [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).

Suggested first representation (design inference): observed labels, nodes with approximate source positions, directed/undirected edges with explicit endpoints, optional edge labels, grouping boundaries, and an `unsupported_or_ambiguous` result. Keep exact visible labels; do not have the model complete unreadable text from lecture knowledge. Render only this validated representation with code we own. Do not execute model-authored JavaScript, Python, SVG markup, or arbitrary rendering programs.

Keep arbitrary geometry, plots requiring numeric precision, anatomy, chemistry, circuit diagrams and dense board derivations out of the initial node-and-edge renderer. Incorrectly flattening these into a graph can change their meaning. General raster editing can be evaluated separately without expanding the renderer into a universal drawing language.

## Fidelity limitations and acceptance

DeepMind warns that generated diagrams can contain misinterpreted information and factual mistakes; small text, spelling and fine details can fail. Improved text rendering is a capability claim, not a fidelity guarantee. [Pro Image limitations](https://deepmind.google/models/gemini-image/pro/). The Flash Image model card also lists hallucinations among its limitations. [Flash Image model card](https://deepmind.google/models/model-cards/gemini-3-1-flash-image/).

Google's prompting guidance recommends explicit factual constraints for diagrams, defining each reference image's role, and verifying data-driven visuals. Those practices improve instructions but do not replace evaluation. [Google prompting guidance](https://blog.google/products-and-platforms/products/gemini/prompting-tips-nano-banana-pro/).

Recommended evaluation before automatic promotion: missing/added labels; changed symbols and inequality signs; missing/reversed edges; wrong node grouping; cropped explanatory conditions; and readability at the actual notes width. Compare final rendering with the original frame, not just with the extracted JSON. A second model can reject obvious discrepancies but shares possible blind spots. Never label an automated pass as human-verified. Rejected, unsupported or uncertain output should leave the original crop visible.

## Cost snapshot (USD)

Standard paid API prices retrieved on 2026-09-21:

| Model | Input / 1M tokens | Text/thinking output / 1M | Generated image output |
| --- | ---: | ---: | ---: |
| `gemini-3.1-flash-image` | $0.50 | $3.00 | $0.067 at 1K; $0.101 at 2K; $0.151 at 4K |
| `gemini-3-pro-image` | $2.00 | $12.00 | $0.134 at 1K/2K; $0.24 at 4K |
| `gemini-3.8-flash` | $0.75 | $3.75 | No image output |

The 3.8 Flash rates are temporary through December 31, 2026. Three 2K redraws cost about $0.303 with Flash Image or $0.402 with Pro **for image output alone**, before image inputs, thinking, extraction, review, retries, storage or frame acquisition. Record actual returned usage per attempt. These are estimates, not a measured Chalkboard generation bill. [Official pricing](https://ai.google.dev/gemini-api/docs/pricing).

## Smallest useful experiment

Use the same handful of source crops in two offline candidates: constrained graph reconstruction for eligible figures and one raster edit per figure. Keep source IDs/times and exact input image hashes. Compare against manually annotated labels/connections and inspect rendered output. Choose by preservation errors and readability, not aesthetic preference alone. No need for a vector database, agent loop, broad provider abstraction or automatic recursive repair to answer that question.
