#!/bin/bash
# xdg-open shim — forwards to avm-bridge so URLs open on the host instead of
# failing inside the container (where there's no display).
#
# Installed at /usr/local/bin/xdg-open by dockerfiles/core.Dockerfile. Any tool
# that falls back to `xdg-open` for opening URLs (gh, claude, npm, etc.) will
# hit this.
exec avm-bridge browser open "$@"
