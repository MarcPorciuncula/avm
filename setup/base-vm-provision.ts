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

const BASE_VM_NAME = "alcova-base";
const VM_USER = "agent";

const args = process.argv.slice(2).filter((a) => a !== "--");
const reprovision = args.includes("--reprovision");

// --- Helpers to run commands in the VM ---

async function asRoot(cmd: string) {
  await $({ input: cmd })`ssh root@${BASE_VM_NAME}@orb bash -l`;
}

async function asAgent(cmd: string) {
  await $({ input: cmd })`ssh ${BASE_VM_NAME}@orb bash -l`;
}

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
console.log(
  `Clone it for agent sessions: orb clone ${BASE_VM_NAME} agent-myproject-feat`
);
