#!/usr/bin/env bash
# HITL (Human-In-The-Loop) debugging script template.
# Used when a human must interact to reproduce a bug.
# Drives the human through structured steps and captures output.

set -euo pipefail

LOG_DIR="${DEBUG_LOG_DIR:-/tmp/debug-hitl}"
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$LOG_DIR/hitl-$TIMESTAMP.log"

echo "[HITL] Starting debug session. Output: $LOG_FILE"
echo "[HITL] Timestamp: $TIMESTAMP"
echo ""

step() {
    local n=$1; shift
    echo "" | tee -a "$LOG_FILE"
    echo "=== Step $n: $* ===" | tee -a "$LOG_FILE"
    echo "[HITL] Press Enter when ready..." | tee -a "$LOG_FILE"
    read -r
}

capture() {
    local label=$1; shift
    echo "[HITL] Capturing: $label" | tee -a "$LOG_FILE"
    echo "--- $label ---" >> "$LOG_FILE"
    "$@" 2>&1 | tee -a "$LOG_FILE"
    echo "--- end $label ---" >> "$LOG_FILE"
}

# --- Steps go here ---

step 1 "Reproduce the issue"
echo "Follow these steps to reproduce:" | tee -a "$LOG_FILE"
echo "  1. <describe step>" | tee -a "$LOG_FILE"
echo "  2. <describe step>" | tee -a "$LOG_FILE"
echo "  3. Observe: <expected vs actual>" | tee -a "$LOG_FILE"
echo ""
echo "[HITL] Paste the output or error message, then press Enter:" | tee -a "$LOG_FILE"
read -r user_output
echo "User observed: $user_output" >> "$LOG_FILE"

step 2 "Collect diagnostics"
capture "git-status" git status --short
capture "git-diff" git diff --stat
capture "recent-logs" tail -50 /var/log/app.log 2>/dev/null || echo "(no log file)"

step 3 "Check environment"
capture "env" env | grep -v -i -E 'secret|password|token|key' || true

echo "" | tee -a "$LOG_FILE"
echo "[HITL] Session complete. Log: $LOG_FILE" | tee -a "$LOG_FILE"
