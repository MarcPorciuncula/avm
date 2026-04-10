# operator-ui End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get a working alcova-vm setup that can spin up a sandboxed Claude Code agent session for the operator-ui repo, with dev server accessible from the host.

**Architecture:** Two zx scripts — `base-vm-provision.ts` (update existing) creates the alcova-base VM with Node 24 + pnpm + buf + Claude Code. `session-setup.ts` (new) clones the base VM, mounts credentials/caches, reference-clones the repos, locks down the host mount, and prints connection info.

**Tech Stack:** TypeScript, zx, OrbStack CLI (`orb`), SSH

**Spec:** `docs/superpowers/specs/2026-04-10-operator-ui-end-to-end-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `setup/base-vm-provision.ts` | Update: Node 22→24, drop Go/Rust, add buf CLI, add corepack enable |
| Create | `setup/session-setup.ts` | Per-session VM setup: clone, mounts, git clones, lockdown |
| Modify | `package.json` | Add `session` script |
| Modify | `.gitignore` | Already covers `data/` — no change needed |

---

### Task 1: Update base-vm-provision.ts

**Files:**
- Modify: `setup/base-vm-provision.ts`

The existing script installs Node 22, Go, and Rust. Update it to match the spec: Node 24, no Go/Rust, add buf CLI and corepack.

- [ ] **Step 1: Replace Node.js 22 with Node.js 24**

Change the nodesource setup line from `setup_22.x` to `setup_24.x`:

```typescript
// --- Node.js (via nodesource) ---

console.log("==> Installing Node.js...");
await asRoot(`
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
`);
```

- [ ] **Step 2: Add corepack enable after Node.js install**

Add this immediately after the Node.js section:

```typescript
// --- pnpm (via corepack) ---

console.log("==> Enabling corepack...");
await asRoot(`
  corepack enable pnpm
`);
```

- [ ] **Step 3: Remove Go installation**

Delete the entire Go section (lines 96-101 in the current file):

```typescript
// DELETE this entire block:
// --- Go ---
console.log("==> Installing Go...");
await asRoot(`
  GO_VERSION="1.24.2"
  curl -fsSL "https://go.dev/dl/go\${GO_VERSION}.linux-arm64.tar.gz" | tar -C /usr/local -xzf -
  echo 'export PATH=\$PATH:/usr/local/go/bin:\$HOME/go/bin' > /etc/profile.d/go.sh
`);
```

- [ ] **Step 4: Remove Rust installation**

Delete the entire Rust section (lines 103-108):

```typescript
// DELETE this entire block:
// --- Rust (via rustup, as agent user) ---
console.log("==> Installing Rust...");
await asAgent(`
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --quiet
`);
```

- [ ] **Step 5: Add buf CLI installation**

Add this after the Python section:

```typescript
// --- buf CLI ---

console.log("==> Installing buf CLI...");
await asRoot(`
  BUF_VERSION="1.50.0"
  curl -fsSL "https://github.com/bufbuild/buf/releases/download/v\${BUF_VERSION}/buf-Linux-aarch64" -o /usr/local/bin/buf
  chmod +x /usr/local/bin/buf
`);
```

- [ ] **Step 6: Remove the SSH config from provisioning**

The SSH config (`~/.ssh/config`) will be provided via the bind-mount from `data/credentials/ssh/` during session setup. Remove the SSH config creation from provisioning to avoid conflicts with the bind-mount (which will overwrite `~/.ssh/` entirely).

Delete this block:

```typescript
// DELETE this block:
await asAgent(`
  cat > ~/.ssh/config << "SSHEOF"
Host github.com
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ~/.ssh/known_hosts
SSHEOF
  chmod 600 ~/.ssh/config
`);
```

Also remove the `mkdir -p ~/.ssh` and `chmod 700 ~/.ssh` from the directory structure step, since session setup handles this via bind-mount. Keep `mkdir -p ~/work`.

Update the directory structure step to:

```typescript
console.log("==> Creating directory structure...");
await asAgent(`
  mkdir -p ~/work
`);
```

- [ ] **Step 7: Update the shebang and usage comments**

Update the header comment to use `pnpm exec tsx` instead of `npx tsx`:

```typescript
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
```

- [ ] **Step 8: Commit**

```bash
git add setup/base-vm-provision.ts
git commit -m "Update base VM provisioning: Node 24, buf CLI, drop Go/Rust"
```

---

### Task 2: Create session-setup.ts

**Files:**
- Create: `setup/session-setup.ts`

This is the main new script. It takes a repo name and branch, produces a running VM.

- [ ] **Step 1: Create the script with argument parsing and VM name derivation**

```typescript
#!/usr/bin/env pnpm exec tsx

/**
 * Set up a new agent session VM for a given repo and branch.
 *
 * Usage:
 *   pnpm exec tsx setup/session-setup.ts operator-ui feat/my-thing
 */

import { $, path } from "zx";
import { existsSync } from "node:fs";

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
```

- [ ] **Step 2: Add helper functions for SSH commands**

```typescript
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
```

- [ ] **Step 3: Add mirror management (step 2a from spec)**

```typescript
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
```

- [ ] **Step 4: Add VM clone and start (step 2b from spec)**

```typescript
// --- Clone and start VM ---

console.log(`==> Cloning ${BASE_VM_NAME} -> ${vmName}...`);
await $`orb clone ${BASE_VM_NAME} ${vmName}`;
await $`orb start ${vmName}`;
await waitForSsh();
```

- [ ] **Step 5: Add bind-mount setup (step 2c from spec)**

```typescript
// --- Bind-mount shared resources ---

console.log("==> Setting up bind-mounts...");
await asRoot(`
  mkdir -p /home/agent/.ssh /home/agent/.claude /home/agent/.local/share/pnpm/store

  mount --bind ${vmHostPrefix}/data/credentials/ssh /home/agent/.ssh
  mount --bind ${vmHostPrefix}/data/credentials/claude /home/agent/.claude
  mount --bind ${vmHostPrefix}/data/cache/shared/pnpm-store /home/agent/.local/share/pnpm/store

  chown -R agent:agent /home/agent/.ssh /home/agent/.claude /home/agent/.local
`);
```

- [ ] **Step 6: Add git config copy (step 2d from spec)**

```typescript
// --- Copy git config ---

console.log("==> Copying git config...");
await asRoot(`
  cp ${vmHostPrefix}/data/credentials/git/.gitconfig /home/agent/.gitconfig
  chown agent:agent /home/agent/.gitconfig
`);
```

- [ ] **Step 7: Add reference-clone repos (step 2e from spec)**

```typescript
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
```

- [ ] **Step 8: Add .env copy (step 2f from spec)**

```typescript
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
```

- [ ] **Step 9: Add host mount lockdown (step 2g from spec)**

```typescript
// --- Lock down host mount ---

console.log("==> Locking down host mount...");
await asRoot(`
  chmod 700 /mnt/mac
  chmod 700 /Users
`);
```

- [ ] **Step 10: Add connection info output (step 2h from spec)**

```typescript
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
```

- [ ] **Step 11: Commit**

```bash
git add setup/session-setup.ts
git commit -m "Add session setup script for per-session VM provisioning"
```

---

### Task 3: Add session script to package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the session script**

Add a `session` script alongside the existing `provision` script:

```json
{
  "scripts": {
    "provision": "tsx setup/base-vm-provision.ts",
    "session": "tsx setup/session-setup.ts"
  }
}
```

This allows `pnpm run session operator-ui feat/my-thing`.

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "Add session script to package.json"
```

---

### Task 4: Ensure data/ directory scaffolding

**Files:**
- Create: `data/credentials/ssh/.gitkeep` (no — data/ is gitignored)

Since `data/` is gitignored, the session-setup script needs to ensure the required directories exist on the host before trying to bind-mount them. If `data/credentials/claude/` doesn't exist, the bind-mount will fail.

- [ ] **Step 1: Add directory scaffolding to session-setup.ts**

Add this right after the argument parsing section (before the mirror management), as the first thing the script does:

```typescript
// --- Ensure data directories exist on host ---

import { mkdirSync } from "node:fs";

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
```

Note: the `mkdirSync` import should be combined with the existing `existsSync` import at the top of the file:

```typescript
import { existsSync, mkdirSync } from "node:fs";
```

- [ ] **Step 2: Commit**

```bash
git add setup/session-setup.ts
git commit -m "Ensure data directories exist before session setup"
```

---

### Task 5: Manual end-to-end test

No code changes — this is the verification run.

- [ ] **Step 1: Populate credentials**

Create the required credential files on the host:

```bash
# From the alcova-vm repo root:
mkdir -p data/credentials/ssh data/credentials/git data/credentials/claude data/credentials/operator-ui data/cache/shared/pnpm-store

# SSH key — copy your key or generate a new one
cp ~/.ssh/id_ed25519 data/credentials/ssh/id_ed25519
cp ~/.ssh/id_ed25519.pub data/credentials/ssh/id_ed25519.pub

# SSH config
cat > data/credentials/ssh/config << 'EOF'
Host github.com
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ~/.ssh/known_hosts
  IdentityFile ~/.ssh/id_ed25519
EOF

# Git config
cat > data/credentials/git/.gitconfig << 'EOF'
[user]
    name = Agent
    email = agent@example.com
[init]
    defaultBranch = main
[pull]
    rebase = true
EOF

# .env — copy from operator-ui repo and fill in real values
# cp /path/to/operator-ui/.env data/credentials/operator-ui/.env
```

- [ ] **Step 2: Provision the base VM (if not already done)**

```bash
pnpm run provision
```

Expected: VM `alcova-base` is created, provisioned, and stopped. Final output:
```
Done. Base VM 'alcova-base' is provisioned and stopped.
```

- [ ] **Step 3: Run session setup**

```bash
pnpm run session operator-ui main
```

Expected: Mirrors are created/fetched, VM is cloned and started, mounts and clones are set up, host is locked down. Final output:
```
Session ready.

  SSH:        ssh agent-operator-ui-main@orb
  Dev server: http://localhost:3000 (after running pnpm dev)
```

- [ ] **Step 4: SSH in and verify the environment**

```bash
ssh agent-operator-ui-main@orb
```

Inside the VM, verify:

```bash
# Repos cloned
ls ~/work/operator-ui ~/work/alcova-backend

# .env in place
cat ~/work/operator-ui/.env

# Node version
node --version  # should be v24.x

# pnpm available
pnpm --version

# buf available
buf --version

# Host mount locked down
ls /mnt/mac  # should get "Permission denied"

# Git SSH works
ssh -T git@github.com  # should say "Hi <user>!"
```

- [ ] **Step 5: Install deps and start dev server**

```bash
cd ~/work/operator-ui
pnpm install
pnpm dev
```

Expected: Dev server starts on port 3000.

- [ ] **Step 6: Verify port forwarding from host**

On the host (not in the VM), open a browser to `http://localhost:3000`. Should see the operator-ui app loading (may show auth errors if Clerk key isn't configured — that's fine, the point is the port forwarding works).

- [ ] **Step 7: Verify Claude Code works (first-time auth)**

Inside the VM:

```bash
cd ~/work/operator-ui
claude
```

Complete the OAuth login flow. After this, `data/credentials/claude/.credentials.json` should exist on the host (via the bind-mount).

- [ ] **Step 8: Clean up test session**

```bash
orb stop agent-operator-ui-main
orb delete -f agent-operator-ui-main
```

- [ ] **Step 9: Commit any fixes discovered during testing**

If any script changes were needed, commit them with an appropriate message.
