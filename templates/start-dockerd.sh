#!/bin/bash
# Start the Docker daemon (DinD). Must be run as root (via sudo).

set -euo pipefail

# Idempotent — exit if already running.
if pidof dockerd > /dev/null 2>&1; then
  echo "Docker daemon is already running."
  exit 0
fi

echo "Starting Docker daemon..."
dockerd > /var/log/dockerd.log 2>&1 &

# Poll until the daemon is ready.
timeout=30
elapsed=0
while ! docker info > /dev/null 2>&1; do
  sleep 1
  elapsed=$((elapsed + 1))
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "Error: Docker daemon failed to start within ${timeout}s." >&2
    echo "Check /var/log/dockerd.log for details." >&2
    exit 1
  fi
done

echo "Docker daemon is ready."
