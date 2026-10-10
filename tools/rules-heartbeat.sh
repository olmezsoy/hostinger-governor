#!/usr/bin/env bash
# The URL is an optional repository secret. Article failures stay unhealthy even after an issue
# was successfully published. No secret means no external request.
set -euo pipefail

if [[ -z "${HEARTBEAT_URL:-}" ]]; then
  exit 0
fi

watch_suffix=""
if [[ "${WATCH_JOB_STATUS:-}" != "success" || "${WATCH_HEALTH:-}" != "ok" ]]; then
  watch_suffix="/fail"
fi
curl -fsS -m 10 --retry 3 -o /dev/null "${HEARTBEAT_URL%/}$watch_suffix"
