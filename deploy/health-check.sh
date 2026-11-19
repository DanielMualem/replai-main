#!/bin/bash
# Basic health monitoring — run via cron every 15 minutes
# */15 * * * * /opt/replai/deploy/health-check.sh >> /var/log/replai-health.log 2>&1

set -euo pipefail

TIMESTAMP=$(date -Iseconds)
ISSUES=0

# Check disk usage
DISK_USAGE=$(df / --output=pcent | tail -1 | tr -d ' %')
if [ "$DISK_USAGE" -gt 90 ]; then
  echo "[$TIMESTAMP] WARN: Disk usage at ${DISK_USAGE}%"
  ISSUES=$((ISSUES + 1))
fi

# Check critical services
for SERVICE in replai nginx fail2ban ssh; do
  if ! systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    echo "[$TIMESTAMP] CRIT: Service $SERVICE is not running"
    ISSUES=$((ISSUES + 1))
  fi
done

# Check if replai is responding
if ! curl -sf -o /dev/null --max-time 5 http://127.0.0.1:3000/ 2>/dev/null; then
  echo "[$TIMESTAMP] WARN: Replai app not responding on port 3000"
  ISSUES=$((ISSUES + 1))
fi

if [ "$ISSUES" -eq 0 ]; then
  echo "[$TIMESTAMP] OK: All checks passed"
fi
