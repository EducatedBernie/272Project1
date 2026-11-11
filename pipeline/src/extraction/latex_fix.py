"""Fix LaTeX commands mangled by JSON escape sequence parsing.

JSON escape sequences that collide with LaTeX commands:
  \f (form feed, \x0c) → \frac, \forall, \flat
  \n (newline, \x0a)   → \neq, \nu, \nabla, \neg, \nleq, \ngeq
  \r (carriage return)  → \rho, \rightarrow, \Rightarrow, \rangle
  \t (tab, \x09)        → \text, \times, \theta, \tau, \triangle
  \b (backspace, \x08)  → \beta, \begin, \binom, \bar, \boldsymbol

These get eaten when the JSON parser interprets them as control characters
instead of literal backslash + letter.
"""

import re

# Map: mangled character → the backslash+letter it should be
_ESCAPE_FIXES = {
    "\x0c": "\\f",  # form feed → \f
    "\x0a": "\\n",  # newline → \n (unlikely inside a JSON string value, but just in case)
    "\x0d": "\\r",  # carriage return → \r
    "\x09": "\\t",  # tab → \t
    "\x08": "\\b",  # backspace → \b
}


def fix_latex_escapes(text: str) -> str:
    """Restore LaTeX commands that were mangled by JSON escape parsing.

    Replaces control characters (form feed, tab, backspace, etc.) that appear
    inside $...$ delimited LaTeX with the original backslash+letter sequence.
    """
    def fix_match(m: re.Match) -> str:
        latex = m.group(0)
        for bad_char, replacement in _ESCAPE_FIXES.items():
            if bad_char in latex:
                latex = latex.replace(bad_char, replacement)
        return latex

    # Fix inside $...$ blocks
    result = re.sub(r'\$[^$]+\$', fix_match, text)

    # Fix double dollar signs: $...$$  →  $...$
    result = re.sub(r'\$\$(?!\$)', '$', result)

    # Fix orphaned trailing dollar signs (not part of a pair)
    # Count dollars — if odd, remove the last one
    dollar_count = result.count('$')
    if dollar_count % 2 == 1:
        # Remove the last unpaired $
        last_idx = result.rfind('$')
        result = result[:last_idx] + result[last_idx + 1:]

    return result
