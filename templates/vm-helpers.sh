# /opt/avm/helpers.sh — sourced by ~/.avm/setup.sh during `avm provision`.
#
# The setup script itself runs as root inside the base VM. Use `as_agent`
# to drop to the agent user for anything that belongs in the agent's home
# (e.g. `go install`, user-scoped config).
#
# Keep this file minimal. Anything you add here is effectively public API
# for user setup scripts and can't be changed without breaking them.

# Run a command as the agent user in a login shell.
# Example: as_agent "go install honnef.co/go/tools/cmd/staticcheck@latest"
as_agent() {
  sudo -u agent -i bash -c "$1"
}

# Print a "==> " heading to match the CLI's own logging.
echo_step() {
  echo "==> $1"
}
