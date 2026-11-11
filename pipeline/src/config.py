"""Shared production configuration for the Chalkboard pipeline."""

# Evaluators and archived experiments intentionally keep their own pinned model
# identifiers. Live process/reprocess/topic-map paths import this default.
DEFAULT_GEMINI_MODEL = "gemini-3.7-flash"
