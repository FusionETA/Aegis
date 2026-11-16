#!/usr/bin/env bash
# Aegis cron wrapper — runs a plugin action under a virtual X display and logs it.
# Usage: run.sh <app>/<action>   -> plugins/<app>/<action>.js, log logs/<app>-<action>.log
#        run.sh <action>         -> AltomateHR (plugins/altomatehr/<action>.js, logs/<action>.log),
#                                   kept for the original clockin | clockout | claims-check cron lines
set -euo pipefail

ACTION="${1:?usage: run.sh <app>/<action> | clockin|clockout|claims-check}"
if [[ ! "$ACTION" =~ ^[a-z0-9-]+(/[a-z0-9-]+)?$ ]]; then
  echo "run.sh: invalid action '${ACTION}' (expected <app>/<action>, lowercase letters, digits, dashes)" >&2
  exit 2
fi
cd "$(dirname "$(readlink -f "$0")")"

if [[ "$ACTION" == */* ]]; then
  SCRIPT="plugins/${ACTION}.js"
else
  SCRIPT="plugins/altomatehr/${ACTION}.js"
fi

# Node binary: override with AEGIS_NODE (e.g. a side-by-side /opt/node24/bin/node
# on hosts whose system node is too old for Playwright).
NODE="${AEGIS_NODE:-/usr/bin/node}"

mkdir -p logs
LOG="logs/${ACTION//\//-}.log"
TS="$(date '+%Y-%m-%d %H:%M:%S %Z')"

# Paused from the Aegis console (config/paused/<app>-<action> exists): log one line, run nothing.
if [[ -e "config/paused/${ACTION//\//-}" ]]; then
  echo "===== ${ACTION} @ ${TS}: paused in the console, skipped =====" >> "$LOG"
  exit 0
fi

# Overlap guard: one run per check at a time. If the previous run is still going
# (a slow site, a retry still waiting), this run is skipped instead of piling up.
exec 8> "/run/lock/aegis-${ACTION//\//-}.lock"
if ! flock -n 8; then
  echo "===== ${ACTION} @ ${TS}: previous run still going, skipped =====" >> "$LOG"
  exit 0
fi

# Checks that don't open a browser ("aegis:no-browser" line) skip the virtual display.
LAUNCH=(/usr/bin/xvfb-run -a)
grep -q 'aegis:no-browser' "$SCRIPT" 2>/dev/null && LAUNCH=()

# Retry: a failed run is run once more after AEGIS_RETRY_DELAY seconds (default
# 300) and alerts only if it fails again (core/report.js holds the first alert
# back). Scripts that change data opt out with an "aegis:no-retry" line, so a
# half-finished action is never repeated.
ATTEMPTS=2
grep -q 'aegis:no-retry' "$SCRIPT" 2>/dev/null && ATTEMPTS=1
DELAY="${AEGIS_RETRY_DELAY:-300}"
FIRST_FAILED_AT=""

run_once() {
  AEGIS_ATTEMPT="$1" AEGIS_ATTEMPTS="$ATTEMPTS" AEGIS_FIRST_FAILED_AT="$FIRST_FAILED_AT" \
    "${LAUNCH[@]}" "$NODE" "$SCRIPT" >> "$LOG" 2>&1
}

echo "===== ${ACTION} @ ${TS} =====" >> "$LOG"
# Capture the exit code instead of letting set -e abort, so failed runs still
# get their footer line; then pass the code through to cron.
RC=0
run_once 1 || RC=$?
if [[ "$RC" -ne 0 && "$ATTEMPTS" -gt 1 ]]; then
  FIRST_FAILED_AT="$(date '+%H:%M')"
  echo "----- ${ACTION} failed (exit ${RC}); retrying in ${DELAY}s -----" >> "$LOG"
  sleep "$DELAY"
  RC=0
  run_once 2 || RC=$?
fi
echo "===== ${ACTION} exit ${RC} @ $(date '+%H:%M:%S %Z') =====" >> "$LOG"
exit "$RC"
