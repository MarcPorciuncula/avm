#!/bin/bash
# Start the Docker daemon (DinD). Must be run as root (via sudo).

set -euo pipefail

timeout_seconds=30
pid_file=/var/run/docker.pid
log_file=/var/log/dockerd.log

# Serialize both automatic and manual startup. Keep the lock file in place:
# flock releases the lock when this process exits, including after a crash.
exec 9>/var/run/avm-dockerd.lock
if ! flock -w "$timeout_seconds" 9; then
  echo "Error: Timed out waiting for another Docker startup attempt." >&2
  exit 1
fi

fail() {
  echo "Error: $*" >&2
  echo "Last Docker daemon log entries ($log_file):" >&2
  tail -n 40 "$log_file" >&2 || true
  exit 1
}

daemon_pid=
if pidof dockerd > /dev/null 2>&1; then
  echo "Docker daemon is running; waiting for it to be ready..."
else
  # The container filesystem survives stop/start, but its processes do not.
  # A leftover PID can even match the new dockerd process itself after reboot.
  # Only discard this runtime file after checking for a real dockerd process.
  rm -f "$pid_file"
  echo "Starting Docker daemon..."
  # The long-lived daemon must not inherit the startup lock or caller's stdin.
  dockerd 9>&- </dev/null > "$log_file" 2>&1 &
  daemon_pid=$!
fi

# Check readiness even for an existing process. Bound each probe too, so a
# stuck Docker API cannot turn the overall readiness timeout into an endless wait.
started_at=$SECONDS
while true; do
  if [ -n "$daemon_pid" ]; then
    if ! kill -0 "$daemon_pid" 2>/dev/null; then
      status=0
      wait "$daemon_pid" || status=$?
      fail "Docker daemon exited during startup (status $status)."
    fi
  elif ! pidof dockerd > /dev/null 2>&1; then
    fail "Docker daemon exited while waiting for readiness."
  fi

  # Always probe the local daemon, regardless of the caller's Docker context.
  if timeout --kill-after=1 1 docker --host unix:///var/run/docker.sock info > /dev/null 2>&1; then
    echo "Docker daemon is ready."
    exit 0
  fi
  if [ "$((SECONDS - started_at))" -ge "$timeout_seconds" ]; then
    fail "Docker daemon failed to become ready within ${timeout_seconds}s."
  fi
  sleep 1
done
