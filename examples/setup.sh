#!/bin/bash
#
# Example ~/.avm/setup.sh — copy to ~/.avm/setup.sh and customize.
#
#   cp <avm-repo>/examples/setup.sh ~/.avm/setup.sh
#
# This script runs as root inside the base VM during `avm provision`,
# after the core provisioner installs Node, Claude Code, and /opt/avm/helpers.sh.
#
# This example reproduces the toolchain used by the Alcova-AI stack:
# Python 3, pnpm, Go (with GOPRIVATE), Atlas, Task, Buf, golangci-lint,
# staticcheck, Docker, and a git URL rewrite for private Alcova repos.
# Trim or extend it to fit your own stack.

set -euo pipefail

source /opt/avm/helpers.sh

# --- Extra system packages --------------------------------------------------

echo_step "Installing extra system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  software-properties-common \
  libssl-dev \
  > /dev/null

# --- pnpm via corepack ------------------------------------------------------

echo_step "Enabling corepack..."
corepack enable pnpm

# --- Python 3 ---------------------------------------------------------------

echo_step "Installing Python 3..."
apt-get install -y -qq python3 python3-pip python3-venv > /dev/null

# --- Buf CLI ----------------------------------------------------------------

echo_step "Installing buf CLI..."
BUF_VERSION="1.50.0"
curl -fsSL \
  "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-Linux-aarch64" \
  -o /usr/local/bin/buf
chmod +x /usr/local/bin/buf

# --- Go toolchain -----------------------------------------------------------

echo_step "Installing Go..."
GO_VERSION=$(curl -fsSL https://go.dev/VERSION?m=text | head -n1)
echo "    version: ${GO_VERSION}"
curl -fsSL "https://go.dev/dl/${GO_VERSION}.linux-arm64.tar.gz" -o /tmp/go.tar.gz
rm -rf /usr/local/go
tar -C /usr/local -xzf /tmp/go.tar.gz
rm /tmp/go.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin:/home/agent/go/bin' > /etc/profile.d/go.sh
chmod +x /etc/profile.d/go.sh

echo_step "Configuring Go for private Alcova modules..."
as_agent '
  export PATH=$PATH:/usr/local/go/bin
  go env -w GOPRIVATE=github.com/Alcova-AI/*
  mkdir -p /home/agent/go/bin
'

# --- Atlas CLI --------------------------------------------------------------

echo_step "Installing Atlas CLI..."
curl -sSf https://atlasgo.sh | sh > /dev/null

# --- Task (taskfile.dev) ----------------------------------------------------

echo_step "Installing Task..."
curl -sL https://taskfile.dev/install.sh | sh -s -- -d -b /usr/local/bin > /dev/null

# --- golangci-lint ----------------------------------------------------------

echo_step "Installing golangci-lint..."
curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh \
  | sh -s -- -b /usr/local/bin > /dev/null

# --- staticcheck (requires Go, runs as agent) -------------------------------

echo_step "Installing staticcheck..."
as_agent '
  export PATH=$PATH:/usr/local/go/bin
  go install honnef.co/go/tools/cmd/staticcheck@latest
'

# --- Docker -----------------------------------------------------------------

echo_step "Installing Docker..."
curl -fsSL https://get.docker.com | sh > /dev/null 2>&1
usermod -aG docker agent
systemctl enable docker > /dev/null 2>&1 || true

# --- Git URL rewriting for Alcova-AI private repos --------------------------

echo_step "Configuring git URL rewriting for Alcova-AI..."
git config --system url."git@github.com:Alcova-AI/".insteadOf "https://github.com/Alcova-AI/"

echo_step "Setup complete."
