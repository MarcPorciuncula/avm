# /opt/avm/helpers.sh — sourced by the agent's .bashrc and by user
# setup scripts (~/.avm/setup.sh).
#
# Functions defined here are available in every interactive shell.
# `as_agent` is for setup scripts that run as root and need to drop
# to the agent user.
#
# Keep this file minimal. Anything you add here is effectively public API
# for user setup scripts and can't be changed without breaking them.

# Run a command as the agent user in a login shell.
#
# The command is piped via stdin to `bash -s`, not passed as an argv arg,
# so multi-line scripts preserve their newlines. Using `-c "$1"` instead
# would let `sudo -i`'s login shell re-split the multi-line argument on
# whitespace and collapse newlines into spaces — breaking any heredoc-style
# setup block.
#
# Example:
#   as_agent "go install honnef.co/go/tools/cmd/staticcheck@latest"
#   as_agent '
#     export PATH=$PATH:/usr/local/go/bin
#     go env -w GOPRIVATE=github.com/my-org/*
#   '
as_agent() {
  sudo -u agent -i bash -s <<< "$1"
}

# Print a "==> " heading to match the CLI's own logging.
echo_step() {
  echo "==> $1"
}

# Start the Docker daemon (DinD). Idempotent — safe to call if already running.
start-dockerd() {
  sudo /opt/avm/start-dockerd.sh
}
