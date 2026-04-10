#!/usr/bin/env pnpm exec tsx

/**
 * Provision the alcova base VM from scratch.
 *
 * Usage:
 *   # Create and provision a new base VM:
 *   pnpm exec tsx setup/base-vm-provision.ts
 *
 *   # Reprovision an existing base VM (wipe and rebuild):
 *   pnpm exec tsx setup/base-vm-provision.ts --reprovision
 *
 * This script is the source of truth for what's in the base VM. If you figure
 * something out interactively, persist it here so the VM is always reproducible.
 */

import { $ } from "zx";
import { BASE_VM_NAME } from "../lib/config.ts";
import { asAgent as asAgentOn, asRoot as asRootOn } from "../lib/vm.ts";

const VM_USER = "agent";

const args = process.argv.slice(2).filter((a) => a !== "--");
const reprovision = args.includes("--reprovision");

// Local wrappers bind the base VM name so the existing call sites stay concise.
const asRoot = (cmd: string) => asRootOn(BASE_VM_NAME, cmd);
const asAgent = (cmd: string) => asAgentOn(BASE_VM_NAME, cmd);

// --- Create or recreate the VM ---

if (reprovision) {
  console.log(`==> Reprovisioning: deleting existing ${BASE_VM_NAME}...`);
  await $`orb stop ${BASE_VM_NAME}`.nothrow();
  await $`orb delete -f ${BASE_VM_NAME}`.nothrow();
}

const vmList = await $`orb list`.quiet();
if (vmList.stdout.includes(BASE_VM_NAME)) {
  console.error(
    `ERROR: ${BASE_VM_NAME} already exists. Use --reprovision to rebuild.`
  );
  process.exit(1);
}

console.log(`==> Creating ${BASE_VM_NAME}...`);
await $`orb create -u ${VM_USER} ubuntu ${BASE_VM_NAME}`;
await $`sleep 2`;

// --- System packages ---

console.log("==> Installing system packages...");
await asRoot(`
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq \
    build-essential \
    curl \
    wget \
    git \
    jq \
    unzip \
    zip \
    tar \
    openssh-client \
    ca-certificates \
    gnupg \
    software-properties-common \
    pkg-config \
    libssl-dev \
    > /dev/null
`);

// --- Git configuration ---

console.log("==> Configuring git...");
await asAgent(`
  git config --global init.defaultBranch main
  git config --global pull.rebase true
`);

// --- Node.js (via nodesource) ---

console.log("==> Installing Node.js...");
await asRoot(`
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
`);

// --- pnpm (via corepack) ---

console.log("==> Enabling corepack...");
await asRoot(`
  corepack enable pnpm
`);

// --- Python ---

console.log("==> Installing Python...");
await asRoot(`
  apt-get install -y -qq python3 python3-pip python3-venv > /dev/null
`);

// --- buf CLI ---

console.log("==> Installing buf CLI...");
await asRoot(`
  BUF_VERSION="1.50.0"
  curl -fsSL "https://github.com/bufbuild/buf/releases/download/v\${BUF_VERSION}/buf-Linux-aarch64" -o /usr/local/bin/buf
  chmod +x /usr/local/bin/buf
`);

// --- Go toolchain ---
// Installs the latest stable Go from go.dev. To pin a specific version,
// replace the curl fetch with GO_VERSION="go1.26.0" or similar.

console.log("==> Installing Go...");
await asRoot(`
  GO_VERSION=$(curl -fsSL https://go.dev/VERSION?m=text | head -n1)
  echo "    version: \${GO_VERSION}"
  curl -fsSL "https://go.dev/dl/\${GO_VERSION}.linux-arm64.tar.gz" -o /tmp/go.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tar.gz
  rm /tmp/go.tar.gz

  # Put Go and the agent's Go bin dir on PATH for all login shells.
  echo 'export PATH=$PATH:/usr/local/go/bin:/home/agent/go/bin' > /etc/profile.d/go.sh
  chmod +x /etc/profile.d/go.sh
`);

console.log("==> Configuring Go for private Alcova modules...");
await asAgent(`
  export PATH=$PATH:/usr/local/go/bin
  go env -w GOPRIVATE=github.com/Alcova-AI/*
  mkdir -p /home/agent/go/bin
`);

// --- Atlas CLI (database migrations) ---

console.log("==> Installing Atlas CLI...");
await asRoot(`
  curl -sSf https://atlasgo.sh | sh > /dev/null
`);

// --- Task (taskfile.dev) ---

console.log("==> Installing Task...");
await asRoot(`
  curl -sL https://taskfile.dev/install.sh | sh -s -- -d -b /usr/local/bin > /dev/null
`);

// --- golangci-lint ---

console.log("==> Installing golangci-lint...");
await asRoot(`
  curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh \
    | sh -s -- -b /usr/local/bin > /dev/null
`);

// --- staticcheck (requires Go) ---

console.log("==> Installing staticcheck...");
await asAgent(`
  export PATH=$PATH:/usr/local/go/bin
  go install honnef.co/go/tools/cmd/staticcheck@latest
`);

// --- Docker + Compose (for alcova-backend's docker-compose stack) ---

console.log("==> Installing Docker...");
await asRoot(`
  curl -fsSL https://get.docker.com | sh > /dev/null 2>&1
  usermod -aG docker agent
  systemctl enable docker > /dev/null 2>&1 || true
`);

// --- Git URL rewriting for Alcova private repos ---
// So \`go mod\` and direct clones both fetch via SSH instead of HTTPS.

console.log("==> Configuring git URL rewriting for Alcova-AI...");
await asRoot(`
  git config --system url."git@github.com:Alcova-AI/".insteadOf "https://github.com/Alcova-AI/"
`);

// --- Claude Code ---

console.log("==> Installing Claude Code...");
await asAgent(`
  curl -fsSL https://claude.ai/install.sh | bash
`);

// --- Standard directories ---

console.log("==> Creating directory structure...");
await asAgent(`
  mkdir -p ~/work
`);

// --- Shell aliases ---

console.log("==> Configuring shell aliases...");
await asAgent(`
  echo 'alias clauded="claude --dangerously-skip-permissions"' >> ~/.bashrc
`);

// --- Stop the VM (it's now a template) ---

console.log(`==> Stopping ${BASE_VM_NAME} (ready as template)...`);
await $`orb stop ${BASE_VM_NAME}`;

console.log();
console.log(`Done. Base VM '${BASE_VM_NAME}' is provisioned and stopped.`);
console.log(`Start an agent session: avm start --clone --attach`);
