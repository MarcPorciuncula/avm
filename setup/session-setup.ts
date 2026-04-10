#!/usr/bin/env pnpm exec tsx

/**
 * Set up a new agent session VM for a given repo and branch.
 *
 * Usage:
 *   pnpm exec tsx setup/session-setup.ts operator-ui feat/my-thing
 */

import { $, path } from "zx";
import { existsSync, mkdirSync } from "node:fs";

const BASE_VM_NAME = "alcova-base";
const GITHUB_ORG = "Alcova-AI";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// Repos to clone into the VM. First is the primary, rest are dependencies.
const REPO_DEPS: Record<string, string[]> = {
  "operator-ui": ["alcova-backend"],
};

// --- Parse args ---

const [repoName, branch] = process.argv.slice(2);
if (!repoName || !branch) {
  console.error("Usage: session-setup.ts <repo> <branch>");
  console.error("Example: session-setup.ts operator-ui feat/my-thing");
  process.exit(1);
}

const sanitizedBranch = branch.replace(/\//g, "-");
const vmName = `agent-${repoName}-${sanitizedBranch}`.slice(0, 63);

// Path to data/ directories on the host
const dataDir = path.join(REPO_ROOT, "data");
const mirrorsDir = path.join(dataDir, "mirrors");
const credentialsDir = path.join(dataDir, "credentials");
const cacheDir = path.join(dataDir, "cache");

// Path prefix inside the VM to reach host files (before lockdown)
const vmHostPrefix = `/mnt/mac${REPO_ROOT}`;

// --- Ensure data directories exist on host ---

for (const dir of [
  path.join(credentialsDir, "ssh"),
  path.join(credentialsDir, "git"),
  path.join(credentialsDir, "claude"),
  path.join(credentialsDir, repoName),
  path.join(cacheDir, "shared", "pnpm-store"),
  mirrorsDir,
]) {
  mkdirSync(dir, { recursive: true });
}

async function asRoot(cmd: string) {
  await $`ssh root@${vmName}@orb -- bash -lc ${cmd}`;
}

async function asAgent(cmd: string) {
  await $`ssh ${vmName}@orb -- bash -lc ${cmd}`;
}

async function waitForSsh() {
  console.log("==> Waiting for SSH...");
  for (let i = 0; i < 30; i++) {
    const result =
      await $`ssh -o ConnectTimeout=1 root@${vmName}@orb -- echo ok`
        .quiet()
        .nothrow();
    if (result.exitCode === 0) return;
    await $`sleep 1`;
  }
  console.error("ERROR: SSH not available after 30s");
  process.exit(1);
}

// --- Ensure mirrors exist and are fresh ---

async function ensureMirror(repo: string) {
  const mirrorPath = path.join(mirrorsDir, `${repo}.git`);
  if (existsSync(mirrorPath)) {
    console.log(`==> Updating mirror: ${repo}...`);
    await $`git -C ${mirrorPath} fetch --all --prune`;
  } else {
    console.log(`==> Creating mirror: ${repo}...`);
    await $`git clone --bare git@github.com:${GITHUB_ORG}/${repo}.git ${mirrorPath}`;
  }
}

console.log("==> Ensuring mirrors are fresh...");
const allRepos = [repoName, ...(REPO_DEPS[repoName] ?? [])];
for (const repo of allRepos) {
  await ensureMirror(repo);
}

// --- Clone and start VM ---

console.log(`==> Cloning ${BASE_VM_NAME} -> ${vmName}...`);
await $`orb clone ${BASE_VM_NAME} ${vmName}`;
await $`orb start ${vmName}`;
await waitForSsh();

// --- Bind-mount shared resources ---

console.log("==> Setting up bind-mounts...");
await asRoot(`
  mkdir -p /home/agent/.ssh /home/agent/.claude /home/agent/.local/share/pnpm/store

  mount --bind ${vmHostPrefix}/data/credentials/ssh /home/agent/.ssh
  mount --bind ${vmHostPrefix}/data/credentials/claude /home/agent/.claude
  mount --bind ${vmHostPrefix}/data/cache/shared/pnpm-store /home/agent/.local/share/pnpm/store

  chown -R agent:agent /home/agent/.ssh /home/agent/.claude /home/agent/.local
`);

// --- Copy git config ---

console.log("==> Copying git config...");
await asRoot(`
  cp ${vmHostPrefix}/data/credentials/git/.gitconfig /home/agent/.gitconfig
  chown agent:agent /home/agent/.gitconfig
`);

// --- Reference-clone repos ---

console.log("==> Cloning repos...");
for (const repo of allRepos) {
  console.log(`    ${repo}...`);
  await asAgent(`
    git clone --dissociate \
      --reference ${vmHostPrefix}/data/mirrors/${repo}.git \
      git@github.com:${GITHUB_ORG}/${repo}.git \
      /home/agent/work/${repo}
  `);
}

// Checkout requested branch on primary repo
console.log(`==> Checking out ${branch}...`);
await asAgent(`
  cd /home/agent/work/${repoName}
  git checkout ${branch} 2>/dev/null || git checkout -b ${branch}
`);

// --- Copy project env file ---

const envFile = path.join(credentialsDir, repoName, ".env");
if (existsSync(envFile)) {
  console.log("==> Copying .env...");
  await asRoot(`
    cp ${vmHostPrefix}/data/credentials/${repoName}/.env /home/agent/work/${repoName}/.env
    chown agent:agent /home/agent/work/${repoName}/.env
  `);
} else {
  console.log(`==> No .env found at data/credentials/${repoName}/.env, skipping.`);
}

// --- Lock down host mount ---

console.log("==> Locking down host mount...");
await asRoot(`
  chmod 700 /mnt/mac
  chmod 700 /Users
`);

// --- Print connection info ---

console.log();
console.log("Session ready.");
console.log();
console.log(`  SSH:        ssh ${vmName}@orb`);
console.log(`  Dev server: http://localhost:3000 (after running pnpm dev)`);
console.log();
console.log("  To start working:");
console.log(`    ssh ${vmName}@orb`);
console.log(`    cd ~/work/${repoName}`);
console.log("    pnpm install");
console.log("    pnpm dev");
