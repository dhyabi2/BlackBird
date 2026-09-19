#!/bin/bash
# Hourly end-to-end probe. Installed as a systemd timer (see below) on the same
# VPS as the indexer, so the status file it writes is the one /api/e2e_status
# serves.
#
#   sudo cp config/vela-e2e.{service,timer} /etc/systemd/system/
#   sudo systemctl enable --now vela-e2e.timer
#   systemctl list-timers vela-e2e.timer
#
# Or, without systemd, as a cron entry:
#   17 * * * * /opt/vela/scripts/run_e2e_monitor.sh >> /var/log/blackbird-e2e.log 2>&1
set -euo pipefail

VELA_ROOT="${VELA_ROOT:-/opt/vela}"
cd "$VELA_ROOT/web"

# Wallet seeds for the probe. Keep this file 0600 and out of git.
if [ -f "$VELA_ROOT/.env.e2e.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$VELA_ROOT/.env.e2e.local"
  set +a
fi

# Write where the indexer reads it.
export E2E_STATE_FILE="${E2E_STATE_FILE:-$VELA_ROOT/data/e2e-monitor.json}"
# The probe drives the public site, exactly as a browser would, so a broken
# deploy is caught too — not just a broken backend.
export VELA_BASE_URL="${VELA_BASE_URL:-https://www.xblackbird.com}"

exec node scripts/e2e-monitor.mjs
