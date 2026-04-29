#!/bin/bash
set -euo pipefail

SERVICE_NAME="${P3_BRIDGE_SERVICE_NAME:-p3-bridge}"
LAUNCHD_LABEL="${P3_BRIDGE_LAUNCHD_LABEL:-com.p3bridge.node}"
OS_NAME="$(uname -s)"

echo "Tailing logs for ${SERVICE_NAME}..."

if [[ "${OS_NAME}" == "Darwin" ]]; then
  echo "Using macOS unified log stream for launchd label ${LAUNCHD_LABEL}"
  log stream --style compact --predicate "process == \"node\" OR eventMessage CONTAINS \"${LAUNCHD_LABEL}\""
else
  sudo journalctl -u "${SERVICE_NAME}" -f
fi
