#!/bin/bash
# Start sshd on the port specified by $AVM_SSH_PORT. Must be run as root (via sudo).

set -euo pipefail

if [ -z "${AVM_SSH_PORT:-}" ]; then
  echo "Error: AVM_SSH_PORT is not set." >&2
  exit 1
fi

# Idempotent — exit if already running.
if pidof sshd > /dev/null 2>&1; then
  echo "sshd is already running."
  exit 0
fi

# Generate host keys if missing (first run after image build).
if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
  echo "Generating SSH host keys..."
  ssh-keygen -A > /dev/null 2>&1
fi

# Authorize the agent user's public key if not already done.
AGENT_HOME=/home/agent
AUTH_KEYS="$AGENT_HOME/.ssh/authorized_keys"
for pubkey in "$AGENT_HOME"/.ssh/*.pub; do
  [ -f "$pubkey" ] || continue
  if [ ! -f "$AUTH_KEYS" ] || ! grep -qF "$(cat "$pubkey")" "$AUTH_KEYS"; then
    cat "$pubkey" >> "$AUTH_KEYS"
  fi
done
if [ -f "$AUTH_KEYS" ]; then
  chown agent:agent "$AUTH_KEYS"
  chmod 600 "$AUTH_KEYS"
fi

# Create the run directory sshd needs.
mkdir -p /run/sshd

echo "Starting sshd on port $AVM_SSH_PORT..."
/usr/sbin/sshd -p "$AVM_SSH_PORT" -o PasswordAuthentication=no

echo "sshd is ready on port $AVM_SSH_PORT."
