#!/usr/bin/env bash
#
# Runs each suspect test file independently with aggressive disk logging.
# After each sync'd log write, if the system logs out, the last entry
# in the log file tells you exactly which file caused it.
#
# Usage: cd cli && bash run-suspect-tests.sh
#

set -euo pipefail

LOG_DIR="/home/username/repos/mstro/.mstro/logs"
LOG_FILE="$LOG_DIR/suspect-tests.log"
mkdir -p "$LOG_DIR"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S.%N')] $1"
  echo "$msg" >> "$LOG_FILE"
  sync "$LOG_FILE"
  echo "$msg"
}

SUSPECT_FILES=(
  "server/services/websocket/autocomplete.test.ts"
  "server/services/websocket/handler.test.ts"
  "server/cli/headless/runner.test.ts"
)

echo "" >> "$LOG_FILE"
log "=========================================="
log "SUSPECT TEST RUN STARTED"
log "pwd: $(pwd)"
log "node: $(node --version)"
log "=========================================="

for file in "${SUSPECT_FILES[@]}"; do
  log "--- ABOUT TO RUN: $file ---"
  log "Launching vitest for $file ..."

  set +e
  npx vitest run "$file" \
    --reporter=verbose \
    --no-file-parallelism \
    >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  set -e

  sync "$LOG_FILE"
  log "FINISHED: $file (exit code: $EXIT_CODE)"
  log "---"
done

log "=========================================="
log "ALL SUSPECT TESTS COMPLETED SUCCESSFULLY"
log "=========================================="
