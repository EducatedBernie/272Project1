"""Pydantic models for Gemini structured output."""

from typing import Literal
from pydantic import BaseModel, Field


class TopicSection(BaseModel):
    start_time: str = Field(description="Start timestamp in MM:SS format")
    end_time: str = Field(description="End timestamp in MM:SS format")
    title: str = Field(description="Short title for this section")
    description: str = Field(description="One sentence description of this section")


class TopicMapOutput(BaseModel):
    summary: str = Field(description="One-line description of what the lecture covers")
    sections: list[TopicSection] = Field(description="Ordered list of topic sections covering the entire lecture")


class TranscriptSegmentOutput(BaseModel):
    text: str = Field(description="The transcribed speech for this segment")
    start_time: str = Field(description="Start timestamp in MM:SS format")
    end_time: str = Field(description="End timestamp in MM:SS format")


class TranscriptExtractionOutput(BaseModel):
    segments: list[TranscriptSegmentOutput] = Field(
        description="Ordered list of transcript segments with timestamps"
    )


class SentenceOutput(BaseModel):
    text: str = Field(description="One transcribed sentence with inline LaTeX where applicable")


class SentenceListOutput(BaseModel):
    sentences: list[SentenceOutput] = Field(
        description="Ordered list of transcribed sentences"
    )


class EquationOutput(BaseModel):
    latex: str = Field(description="LaTeX representation of the equation")
    description: str = Field(
        description="Natural language description of the equation for accessibility alt-text"
    )
    discussed_start: str = Field(
        description="Start timestamp (MM:SS) when this equation is actively being written or discussed"
    )
    discussed_end: str = Field(
        description="End timestamp (MM:SS) when discussion of this equation ends"
    )
    confidence: float = Field(
        description="Confidence score from 0.0 to 1.0 for the accuracy of the LaTeX extraction"
    )


class EquationExtractionOutput(BaseModel):
    equations: list[EquationOutput] = Field(
        description="List of equations extracted from the video"
    )


class TextBlock(BaseModel):
    kind: Literal["heading", "paragraph", "bullet"] = Field(
        description="Block kind: heading (title on the slide), paragraph (running text), bullet (list item)"
    )
    text: str = Field(description="The text content, with inline $...$ for math")
    depth: int = Field(
        default=0,
        description="Nesting depth for bullets. 0 = top-level bullet, 1 = sub-bullet. Always 0 for heading/paragraph."
    )


class VisualContentItem(BaseModel):
    # visual_observation MUST stay first. Pydantic field declaration order =
    # JSON property order under structured-output, so this field emits before
    # content_type, forcing Gemini to describe what it sees BEFORE classifying.
    # Empirically dropped misplacement from 7.1% to 4.4% on DSC30 (EXP2,
    # 2026-04-30). default="" keeps backward compatibility for old DB rows
    # and demo JSONs that predate the field. See test_visual_observation_is_first_field.
    visual_observation: str = Field(
        default="",
        description=(
            "1-2 sentence raw description of what is visible BEFORE classifying. "
            "Just describe: handwriting? printed text? a table grid? a diagram with "
            "arrows? raw symbols? Do NOT classify yet. If you can't see clearly, "
            "say so. This field exists to force reasoning before commitment to "
            "content_type."
        ),
    )
    content_type: str = Field(
        description="Type of visual content: equation, code, table, chart_description, diagram_description, text, or other. Pick this AFTER you've written visual_observation."
    )
    description: str = Field(
        default="",
        description="Natural language description for accessibility. Primary content for equation (as alt-text), diagram_description, chart_description, and other. Leave empty for text, table, code — their dedicated fields carry the content."
    )
    discussed_start: str = Field(
        description="Start timestamp (MM:SS) when this content is actively being written or displayed"
    )
    discussed_end: str = Field(
        description="End timestamp (MM:SS) when this content stops being actively presented"
    )
    confidence: float = Field(
        description="Confidence score from 0.0 to 1.0 for the accuracy of the extraction"
    )
    latex: str = Field(default="", description="LaTeX representation. Only for content_type 'equation'")
    code: str = Field(default="", description="The code text, verbatim. Only for content_type 'code'")
    language: str = Field(default="", description="Programming language (lowercase). Only for content_type 'code'")
    purpose: str = Field(default="", description="ONE sentence stating what the code does. Only for content_type 'code'")
    structure: list[str] = Field(default_factory=list, description="Ordered list of high-level code blocks. Only for content_type 'code'")
    headers: list[str] = Field(default_factory=list, description="Column headers. Only for content_type 'table'")
    rows: list[list[str]] = Field(default_factory=list, description="Table data rows. Only for content_type 'table'")
    title: str = Field(default="", description="Table title/heading as written. Only for content_type 'table'")
    caption: str = Field(default="", description="ONE sentence stating what the table shows. Only for content_type 'table'")
    text_blocks: list[TextBlock] = Field(default_factory=list, description="Structured text blocks. Only for content_type 'text'")


class VisualContentExtractionOutput(BaseModel):
    items: list[VisualContentItem] = Field(
        description="List of visual content items extracted from the video"
    )
