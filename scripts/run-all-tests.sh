#!/usr/bin/env bash
# Run every Chalkboard test suite and save logs to docs/testing/logs/.
# Prerequisites (see README "Running the tests"):
#   docker compose up -d db                       # provides the chalkboard_test database
#   (cd pipeline && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]")
#   (cd viewer && npm ci && npx playwright install chromium)
# Usage: scripts/run-all-tests.sh [pipeline|viewer|a11y|all]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/docs/testing/logs"
mkdir -p "$LOGS"
which="${1:-all}"
status=0

# tee to the terminal, save an ANSI-stripped copy to the log
save() { tee >(sed -E $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' > "$1"); }

banner() { printf '\n\033[1;36m━━ %s ━━\033[0m\n' "$1"; }

if [[ "$which" == pipeline || "$which" == all ]]; then
  banner "Pipeline (pytest) — unit + DB-backed tests"
  PY="$ROOT/pipeline/.venv/bin/python"; [[ -x "$PY" ]] || PY=python3
  (cd "$ROOT/pipeline" && "$PY" -m pytest tests/ -p no:cacheprovider) 2>&1 | save "$LOGS/pipeline.log"
  [[ ${PIPESTATUS[0]} -eq 0 ]] || status=1
fi

if [[ "$which" == viewer || "$which" == all ]]; then
  banner "Viewer unit tests (node:test)"
  (cd "$ROOT/viewer" && npm test --silent) 2>&1 | save "$LOGS/viewer.log"
  [[ ${PIPESTATUS[0]} -eq 0 ]] || status=1
  banner "Viewer typecheck (tsc --noEmit)"
  (cd "$ROOT/viewer" && npx tsc --noEmit && echo "tsc: 0 errors") 2>&1 | save "$LOGS/typecheck.log"
  [[ ${PIPESTATUS[0]} -eq 0 ]] || status=1
fi

if [[ "$which" == a11y || "$which" == all ]]; then
  banner "Accessibility (Playwright: axe-core + virtual screen reader)"
  (cd "$ROOT/viewer" && npx playwright test --reporter=list) 2>&1 | save "$LOGS/a11y.log"
  [[ ${PIPESTATUS[0]} -eq 0 ]] || status=1
fi

exit $status
