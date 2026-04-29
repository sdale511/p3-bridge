#!/bin/bash
set -euo pipefail

SERVICE_NAME="${P3_BRIDGE_SERVICE_NAME:-p3-bridge}"
LAUNCHD_LABEL="${P3_BRIDGE_LAUNCHD_LABEL:-$SERVICE_NAME}"
OS_NAME="$(uname -s)"

echo "Starting ${SERVICE_NAME}..."

if [[ "${OS_NAME}" == "Darwin" ]]; then
  if launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}"
    launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" | sed -n '1,40p'
  elif launchctl print "system/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
    sudo launchctl kickstart -k "system/${LAUNCHD_LABEL}"
    sudo launchctl print "system/${LAUNCHD_LABEL}" | sed -n '1,40p'
  else
    echo "launchctl job not found for label: ${LAUNCHD_LABEL}"
    echo "Set P3_BRIDGE_LAUNCHD_LABEL if your launchd label is different."
    exit 1
  fi
else
  sudo systemctl start "${SERVICE_NAME}"
  sudo systemctl status "${SERVICE_NAME}" --no-pager
fi
