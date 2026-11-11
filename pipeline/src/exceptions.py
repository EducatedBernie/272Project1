"""Pipeline-wide exception types.

`CancelledError` lives here (not in `scripts/worker.py`) because the worker
is launched as `python scripts/worker.py`, which makes it `__main__`.
Importing `from scripts.worker import CancelledError` in any other file
would then re-import the worker module under the name `scripts.worker`,
producing a *second* class object distinct from the `__main__.CancelledError`
that worker.py's own `except CancelledError:` clauses bind to. Cancel
exceptions raised from the pipeline path would skip those handlers and
fall through to `except Exception:`, writing a traceback to
`pipeline_runs.error` instead of "Cancelled by user". Hosting the class
in a third module that both files import from defeats the dual-class
hazard regardless of how the worker is launched.

See: docs/superpowers/reviews/2026-04-28-cancel-error-fix-review.md and
the regression test test_poll_once_cancelled_with_cross_module_class.
"""


class CancelledError(Exception):
    """Raised inside the pipeline when a run's cancel_requested flag is set.

    Caught specifically in worker.poll_once so we mark the run as failed
    with a user-friendly "Cancelled by user" message instead of dumping a
    traceback and firing a Slack failure alert.
    """


class ExtractionFailedError(Exception):
    """Raised when a Gemini extraction call exhausts retries.

    This is distinct from a successful extraction that legitimately returns no
    visual artifacts. Letting exhausted request failures collapse to [] makes
    the pipeline save fake-success empty runs.
    """
