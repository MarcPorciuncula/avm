import { $, path } from "zx";
import { readFileSync } from "node:fs";
import {
  BASE_VM_NAME,
  REPO_ROOT,
  vmHostAvmHome,
} from "./config.ts";
import { asAgent as asAgentOn, asRoot as asRootOn } from "./vm.ts";

const VM_USER = "agent";

const asRoot = (cmd: string) => asRootOn(BASE_VM_NAME, cmd);
const asAgent = (cmd: string) => asAgentOn(BASE_VM_NAME, cmd);

/**
 * Provision the base VM from scratch. Caller is responsible for ensuring
 * the VM does not already exist (delete it first if needed).
 *
 * This function installs ONLY the minimal core — the things every avm
 * session needs regardless of what toolchain the user layers on top.
 * Toolchain install (Go, Docker, language runtimes, etc.) happens via
 * ~/.avm/setup.sh, which is copied into the VM and run as root at the end.
 *
 * The core list is the source of truth for what "minimal" means. Don't
 * grow this function without updating the design spec at
 * docs/superpowers/specs/2026-04-10-avm-generalization-design.md.
 */
export async function provisionBaseVm(): Promise<void> {
  console.log(`==> Creating ${BASE_VM_NAME}...`);
  await $`orb create -u ${VM_USER} ubuntu ${BASE_VM_NAME}`;
  await $`sleep 2`;

  // --- Core system packages ---

  console.log("==> Installing core system packages...");
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
      pkg-config \
      > /dev/null
  `);

  // --- Git defaults ---

  console.log("==> Configuring git defaults...");
  await asAgent(`
    git config --global init.defaultBranch main
    git config --global pull.rebase true
  `);

  // --- Node.js (via nodesource) — required by Claude Code ---

  console.log("==> Installing Node.js...");
  await asRoot(`
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null
  `);

  // --- Claude Code ---

  console.log("==> Installing Claude Code...");
  await asAgent(`
    curl -fsSL https://claude.ai/install.sh | bash
  `);

  // --- Standard directories ---

  console.log("==> Creating agent work directory...");
  await asAgent(`
    mkdir -p ~/work
  `);

  // --- Shell aliases ---

  console.log("==> Configuring shell aliases...");
  await asAgent(`
    echo 'alias clauded="claude --dangerously-skip-permissions"' >> ~/.bashrc
  `);

  // --- Install helpers library ---

  console.log("==> Installing /opt/avm/helpers.sh...");
  const helpersPath = path.join(REPO_ROOT, "templates", "vm-helpers.sh");
  const helpersContents = readFileSync(helpersPath, "utf-8");
  // Can't use asRoot here — asRoot pipes the *command* via stdin, but we
  // need to pipe the helpers file *contents* via stdin so `cat` can
  // receive them. Direct SSH call with the command as an argument.
  await $({
    input: helpersContents,
  })`ssh root@${BASE_VM_NAME}@orb "mkdir -p /opt/avm && cat > /opt/avm/helpers.sh && chmod 644 /opt/avm/helpers.sh"`;

  // --- Run the user's setup.sh ---
  //
  // The base VM's /mnt/mac mount still exposes the host filesystem during
  // provisioning — the lockdown that masks /mnt/mac only applies to
  // session VMs, not the template. We copy the script to /tmp first so
  // the post-lockdown VMs never need to re-read it from /mnt/mac.
  //
  // If setup.sh exits non-zero, the whole provision fails loudly and the
  // partially-provisioned VM is left for the next `avm provision` to
  // delete and rebuild from scratch.

  console.log("==> Running user setup.sh...");
  await asRoot(`
    set -e
    cp "${vmHostAvmHome}/setup.sh" /tmp/avm-user-setup.sh
    bash /tmp/avm-user-setup.sh
    rm /tmp/avm-user-setup.sh
  `);

  // --- Stop the VM (it's now a template) ---

  console.log(`==> Stopping ${BASE_VM_NAME} (ready as template)...`);
  await $`orb stop ${BASE_VM_NAME}`;
}
