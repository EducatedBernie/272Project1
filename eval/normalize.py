"""LaTeX normalizer for equation comparison.

Strips delimiters, normalizes whitespace, and canonicalizes equivalent LaTeX
forms so that ground truth and pipeline output can be compared fairly.
"""

import re


def normalize_latex(s: str) -> str:
    """Normalize a LaTeX string for comparison."""
    s = s.strip()

    # Strip $ delimiters
    s = re.sub(r'^\$+|\$+$', '', s)

    # Strip display math
    s = re.sub(r'\\displaystyle\s*', '', s)
    s = re.sub(r'\\textstyle\s*', '', s)

    # Strip \text{...} wrappers but keep content
    s = re.sub(r'\\text\{([^}]*)\}', r'\1', s)

    # Strip font commands: \mathsf{X} → X, \mathrm{X} → X, etc.
    for cmd in ['mathsf', 'mathrm', 'mathbf', 'mathit', 'mathbb', 'mathcal',
                'boldsymbol', 'textbf', 'textit']:
        s = re.sub(rf'\\{cmd}\{{([^}}]*)\}}', r'\1', s)

    # Strip \mathrel{\mathop{}} and similar empty wrappers
    s = re.sub(r'\\mathrel\{[^}]*\}', '', s)
    s = re.sub(r'\\mathop\{[^}]*\}', '', s)

    # Strip \left and \right
    s = re.sub(r'\\left\s*', '', s)
    s = re.sub(r'\\right\s*', '', s)

    # Normalize brackets: \langle → (, \rangle → ), [ → (, ] → (
    s = s.replace('\\langle', '(')
    s = s.replace('\\rangle', ')')
    s = s.replace('[', '(')
    s = s.replace(']', ')')

    # Normalize inequality: \le, \leq → <, \ge, \geq → >
    s = s.replace('\\leq', '<')
    s = s.replace('\\le', '<')
    s = s.replace('\\geq', '>')
    s = s.replace('\\ge', '>')

    # Normalize multiplication: \times, \cdot, * → remove (implicit multiplication)
    s = s.replace('\\times', '')
    s = s.replace('\\cdot', '')
    s = s.replace('*', '')

    # Strip tilde spacing: ~{} → nothing
    s = re.sub(r'~\{\}', '', s)
    s = s.replace('~', '')

    # Strip \, and other thin spaces
    s = re.sub(r'\\[,;:!]', '', s)

    # Normalize \frac{a}{b} → a/b
    for _ in range(5):
        s = re.sub(r'\\frac\{([^{}]+)\}\{([^{}]+)\}', r'(\1)/(\2)', s)
    # Clean up parens around simple expressions (including those with backslash commands)
    s = re.sub(r'\(([a-zA-Z0-9^_!{}\\]+)\)', r'\1', s)

    # Normalize \exp(...) → e^{...}
    s = re.sub(r'\\exp\s*\(([^)]*)\)', r'e^{\1}', s)
    s = re.sub(r'\\exp\s*\{([^}]*)\}', r'e^{\1}', s)

    # Remove redundant braces around single characters
    s = re.sub(r'\{([a-zA-Z0-9])\}', r'\1', s)

    # Normalize spacing
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'\s*([=+\-*/^_{}()\\<>])\s*', r'\1', s)
    s = re.sub(r'(\\[a-zA-Z]+)([^a-zA-Z{\\])', r'\1 \2', s)
    s = re.sub(r'\s+', ' ', s).strip()

    return s


def normalize_for_containment(s: str) -> str:
    """Aggressive normalization for substring containment checks.

    Case-insensitive, no whitespace, no multiplication operators.
    """
    s = normalize_latex(s)
    s = re.sub(r'\s', '', s)
    s = s.lower()
    # Strip trailing commas/periods
    s = s.rstrip(',.')
    return s
