# avm Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip Alcova-specific content from `avm`, relocate user state from `<repo>/data/` to `~/.avm/`, split base-VM provisioning into core + user `setup.sh`, introduce a docker-compose-style `~/.avm/config.yaml` for declarative mounts, and split `avm start` into `avm create` + resume-only `avm start`.

**Architecture:** Thin wrapper over `orb` + SSH stays the same. Host state moves under `~/.avm/` (`system/`, `mirrors/`, `volumes/`, `files/`, `config.yaml`, `setup.sh`). Base VM provisioning becomes core-only; users layer toolchains via `~/.avm/setup.sh`. Session mount/lockdown orchestration extracts into `lib/session.ts`, shared by a new `cli/commands/create.ts` and a rewritten `cli/commands/start.ts`. Per-repo symlinks are handled at clone-time by a generated `/usr/local/bin/avm-link` inside the VM, driven off `config.yaml`.

**Tech Stack:** TypeScript, citty (CLI framework), google/zx (shell), esbuild (bundler), `@clack/prompts` (interactive), `yaml` (new dep for config parsing). OrbStack + SSH. pnpm package manager. No test framework — verification is manual end-to-end per project convention.

---

## Ground Rules for This Plan

- **No automated tests.** Per `CLAUDE.md`: "No automated tests. This is a CLI glue layer; the valuable verification is running the commands end-to-end." Every task's verification step is a real command against the real CLI (or a defensible "doesn't compile, so nothing else matters" gate).
- **Each task ends with `pnpm run build`.** That's the only build gate this project has (esbuild; no `tsc` typecheck step exists). A build failure means broken imports or syntax — fix before committing.
- **Commit after every task.** Keep diffs reviewable. Commit messages below are suggestions; use the project's own style.
- **Reference the spec, don't repeat it.** The design spec at `docs/superpowers/specs/2026-04-10-avm-generalization-design.md` is the source of truth for intent. This plan is the source of truth for sequencing and exact code.
- **Current user state (`<repo>/data/`) is left alone.** No migration. The user will delete old VMs and move files manually after the refactor lands. Don't touch `data/` or the `.gitignore` entry during implementation.

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `lib/config-file.ts` | Parse `~/.avm/config.yaml`, validate schema, generate `avm-link` bash script |
| `lib/session.ts` | `applySessionMounts` + `applyLockdown` — shared session setup for `create` and `start` |
| `cli/commands/create.ts` | `avm create` — creates a fresh session VM (old create path from `start.ts`) |
| `templates/vm-helpers.sh` | VM-side `as_agent` / `echo_step` helpers, installed at `/opt/avm/helpers.sh` |
| `examples/setup.sh` | Working user setup script — bash translation of the current Alcova-specific parts of `lib/base-vm.ts` |

**Rewritten files:**

| Path | Changes |
|---|---|
| `lib/config.ts` | Rewrite paths to point at `~/.avm/*`; delete Alcova constants |
| `lib/base-vm.ts` | Shrunk to minimal core; installs `/opt/avm/helpers.sh`; copies + runs `~/.avm/setup.sh` |
| `cli/commands/provision.ts` | Drop `LEGACY_BASE_VM_NAME` migration; add precondition check for `~/.avm/setup.sh` |
| `cli/commands/start.ts` | Resume-only; required `id` arg resolved via `resolveVmByPrefix`; delegates to `lib/session.ts` |
| `cli/avm.ts` | Register `create` subcommand alongside `start` |
| `templates/vm-claude.md` | Generic (no Alcova refs); documents `~/work/`, `~/mirrors/`, `~/.avm-files/`, `avm-link`, `clauded`, `avm create` vs `avm start` |
| `README.md`, `CLAUDE.md`, `skills/avm/SKILL.md` | Reflect new layout and command split |

**Deleted files:**

| Path | Why |
|---|---|
| `lib/mirrors.ts` | Only used by the deleted `--clone` flow; mirror lifecycle becomes the user's responsibility |

**Task ordering is additive-first.** New code lands before old code is removed, so every commit compiles.

---

## Task 1: Add `yaml` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the `yaml` package**

```bash
pnpm add yaml
```

- [ ] **Step 2: Verify it's in `package.json` under `dependencies`**

```bash
cat package.json
```

Expected: a new line under `dependencies` like `"yaml": "^2.x.x"`. `pnpm-lock.yaml` should also be updated.

- [ ] **Step 3: Run the build to make sure nothing broke**

```bash
pnpm run build
```

Expected: `Built dist/avm.mjs` with no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "Add yaml dep for ~/.avm/config.yaml parsing"
```

---

## Task 2: Add new path constants to `lib/config.ts` (additive)

Add the new `~/.avm/*` paths without touching the old constants. Old consumers keep working; new code can start using the new paths. Old constants get deleted in Task 12 after nothing uses them.

**Files:**
- Modify: `lib/config.ts`

- [ ] **Step 1: Add `os` import and new path constants to `lib/config.ts`**

At the top of the file, alongside the existing `path` import, add `os`:

```ts
import { path } from "zx";
import os from "node:os";
import { fileURLToPath } from "node:url";
```

At the bottom of the file (below `vmHostPrefix`), add the new block:

```ts
// --- New ~/.avm/ layout (see docs/superpowers/specs/2026-04-10-avm-generalization-design.md) ---

export const AVM_HOME = path.join(os.homedir(), ".avm");

export const avmSystemDir = path.join(AVM_HOME, "system");
export const avmSystemSshDir = path.join(avmSystemDir, "credentials/ssh");
export const avmSystemGitConfigFile = path.join(
  avmSystemDir,
  "credentials/git/.gitconfig",
);
export const avmSystemClaudeDir = path.join(avmSystemDir, "claude");
export const avmSystemClaudeJsonFile = path.join(avmSystemDir, "claude.json");

export const avmMirrorsDir = path.join(AVM_HOME, "mirrors");
export const avmVolumesDir = path.join(AVM_HOME, "volumes");
export const avmFilesDir = path.join(AVM_HOME, "files");

export const avmConfigFile = path.join(AVM_HOME, "config.yaml");
export const avmSetupScript = path.join(AVM_HOME, "setup.sh");

/** VM-side pre-lockdown path that reaches `~/.avm` on the host. */
export const vmHostAvmHome = `/mnt/mac${AVM_HOME}`;
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

Expected: clean build. No consumers of the new constants yet, so there's nothing to break.

- [ ] **Step 3: Commit**

```bash
git add lib/config.ts
git commit -m "Add ~/.avm/ path constants to lib/config.ts"
```

---

## Task 3: Create `lib/config-file.ts`

Parse `~/.avm/config.yaml`, validate strictly, and generate the `avm-link` bash script. Nothing consumes this file yet — Task 8 (`lib/session.ts`) will.

**Files:**
- Create: `lib/config-file.ts`

- [ ] **Step 1: Create the file**

Write the full contents:

```ts
import { readFileSync, existsSync } from "node:fs";
import { path } from "zx";
import { parseDocument } from "yaml";
import { avmConfigFile } from "./config.ts";

// ---------- Types ----------

export interface AvmConfig {
  volumes: VolumeMount[];
  repos: Record<string, RepoConfig>;
}

export interface VolumeMount {
  /** Raw source string as written in config.yaml (relative to ~/.avm/volumes/ unless absolute). */
  source: string;
  /** Raw target string as written in config.yaml (relative to /home/agent/ unless absolute; ~/ expands to /home/agent/). */
  target: string;
}

export interface RepoConfig {
  symlinks: SymlinkMount[];
}

export interface SymlinkMount {
  /** Raw source, relative to ~/.avm/files/. */
  source: string;
  /** Raw target, relative to the avm-link invocation cwd (typically a repo working copy). */
  target: string;
}

// ---------- Public API ----------

/**
 * Load and validate `~/.avm/config.yaml`. Returns an empty config if the
 * file does not exist. Throws on schema errors with a message that
 * identifies the offending key.
 */
export function loadAvmConfig(): AvmConfig {
  if (!existsSync(avmConfigFile)) {
    return { volumes: [], repos: {} };
  }
  const raw = readFileSync(avmConfigFile, "utf-8");
  return parseAvmConfig(raw);
}

/** Parse + validate YAML content. Separated from I/O for testability. */
export function parseAvmConfig(yamlSource: string): AvmConfig {
  const doc = parseDocument(yamlSource);
  if (doc.errors.length > 0) {
    const msg = doc.errors.map((e) => e.message).join("\n");
    throw new Error(`Invalid YAML in ${avmConfigFile}:\n${msg}`);
  }
  const data = (doc.toJS() ?? {}) as unknown;
  return validate(data);
}

/**
 * Generate the bash source of `/usr/local/bin/avm-link` from a loaded config.
 * The script dispatches on `$1` (or `$(basename "$PWD")`) and applies the
 * symlinks declared for that repo. Repos not in the config are a no-op.
 */
export function generateAvmLinkScript(config: AvmConfig): string {
  const lines: string[] = [
    "#!/bin/bash",
    "# Generated by avm — do not edit",
    "set -e",
    'repo="${1:-$(basename "$PWD")}"',
    'case "$repo" in',
  ];

  for (const [repoName, repoConfig] of Object.entries(config.repos)) {
    lines.push(`  ${repoName})`);
    for (const link of repoConfig.symlinks) {
      const src = `$HOME/.avm-files/${link.source}`;
      const parent = path.dirname(link.target);
      if (parent !== "." && parent !== "/") {
        lines.push(`    mkdir -p "${parent}"`);
      }
      lines.push(`    ln -sf "${src}" "${link.target}"`);
    }
    lines.push("    ;;");
  }

  lines.push("  *)");
  lines.push("    exit 0");
  lines.push("    ;;");
  lines.push("esac");
  lines.push("");

  return lines.join("\n");
}

// ---------- Validation ----------

const TOP_LEVEL_KEYS = new Set(["volumes", "repos"]);
const REPO_KEYS = new Set(["symlinks"]);

function validate(data: unknown): AvmConfig {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `${avmConfigFile}: top-level must be a mapping (got ${describe(data)}).`,
    );
  }

  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new Error(
        `${avmConfigFile}: unknown top-level key "${key}". Allowed: ${[...TOP_LEVEL_KEYS].join(", ")}.`,
      );
    }
  }

  const volumes = parseVolumes(obj.volumes);
  const repos = parseRepos(obj.repos);
  return { volumes, repos };
}

function parseVolumes(raw: unknown): VolumeMount[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "volumes" must be a list (got ${describe(raw)}).`,
    );
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new Error(
        `${avmConfigFile}: volumes[${i}] must be a "source:target" string (got ${describe(entry)}).`,
      );
    }
    return splitShortForm(entry, `volumes[${i}]`);
  });
}

function parseRepos(raw: unknown): Record<string, RepoConfig> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "repos" must be a mapping (got ${describe(raw)}).`,
    );
  }
  const out: Record<string, RepoConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `${avmConfigFile}: repos.${name} must be a mapping (got ${describe(value)}).`,
      );
    }
    const repoObj = value as Record<string, unknown>;
    for (const key of Object.keys(repoObj)) {
      if (!REPO_KEYS.has(key)) {
        throw new Error(
          `${avmConfigFile}: unknown key "${key}" under repos.${name}. Allowed: ${[...REPO_KEYS].join(", ")}.`,
        );
      }
    }
    out[name] = { symlinks: parseSymlinks(repoObj.symlinks, name) };
  }
  return out;
}

function parseSymlinks(raw: unknown, repoName: string): SymlinkMount[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: repos.${repoName}.symlinks must be a list (got ${describe(raw)}).`,
    );
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new Error(
        `${avmConfigFile}: repos.${repoName}.symlinks[${i}] must be a "source:target" string (got ${describe(entry)}).`,
      );
    }
    return splitShortForm(entry, `repos.${repoName}.symlinks[${i}]`);
  });
}

/** Split "source:target" on the first colon. Both sides must be non-empty. */
function splitShortForm(
  entry: string,
  context: string,
): { source: string; target: string } {
  const idx = entry.indexOf(":");
  if (idx === -1) {
    throw new Error(
      `${avmConfigFile}: ${context} ("${entry}") must be "source:target".`,
    );
  }
  const source = entry.slice(0, idx);
  const target = entry.slice(idx + 1);
  if (source.length === 0 || target.length === 0) {
    throw new Error(
      `${avmConfigFile}: ${context} ("${entry}") has an empty source or target.`,
    );
  }
  return { source, target };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value;
}
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

Expected: `Built dist/avm.mjs`.

- [ ] **Step 3: Sanity-check the generator with `pnpm run dev`**

Use tsx to run a one-liner that exercises the parser and generator against the spec's example YAML, so we catch wiring issues before Task 8 depends on it:

```bash
pnpm exec tsx -e '
import { parseAvmConfig, generateAvmLinkScript } from "./lib/config-file.ts";
const yaml = `
volumes:
  - pnpm-store:~/.local/share/pnpm/store
repos:
  operator-ui:
    symlinks:
      - envs/operator-ui.env:.env
  alcova-backend:
    symlinks:
      - envs/alcova-backend.env:.env
      - configs/alcova-backend/local.yml:config/local.yml
`;
const cfg = parseAvmConfig(yaml);
console.log(JSON.stringify(cfg, null, 2));
console.log("---");
console.log(generateAvmLinkScript(cfg));
'
```

Expected output: a parsed `AvmConfig` object followed by a bash script that matches the structure of the example in the spec ("Generated `avm-link`" section) — with `case "$repo" in`, `operator-ui)`, `alcova-backend)`, and a `*)` fallthrough.

- [ ] **Step 4: Sanity-check a validation error**

```bash
pnpm exec tsx -e '
import { parseAvmConfig } from "./lib/config-file.ts";
try {
  parseAvmConfig("volume:\n  - foo:bar\n");
} catch (err) {
  console.log("OK:", (err as Error).message);
}
'
```

Expected: an "unknown top-level key \"volume\"" error (singular instead of plural catches the typo the spec warned about).

- [ ] **Step 5: Commit**

```bash
git add lib/config-file.ts
git commit -m "Add lib/config-file.ts — parse ~/.avm/config.yaml, generate avm-link"
```

---

## Task 4: Create `templates/vm-helpers.sh`

The minimal helpers library installed at `/opt/avm/helpers.sh` inside every provisioned base VM. User setup scripts source it.

**Files:**
- Create: `templates/vm-helpers.sh`

- [ ] **Step 1: Write the file**

```bash
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
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

Expected: clean build (this file isn't imported by anything yet but adding it shouldn't break anything either).

- [ ] **Step 3: Commit**

```bash
git add templates/vm-helpers.sh
git commit -m "Add templates/vm-helpers.sh — core helpers library for user setup scripts"
```

---

## Task 5: Create `examples/setup.sh`

A working user setup script that reproduces the current Alcova toolchain via `/opt/avm/helpers.sh`. The user will copy this verbatim to `~/.avm/setup.sh` on first install.

This is a **lossless translation** of everything in the current `lib/base-vm.ts` that isn't in the new core list: Python3, buf, Go + GOPRIVATE, Atlas, Task, golangci-lint, staticcheck, Docker, Alcova-AI git URL rewrite, plus corepack/pnpm.

**Files:**
- Create: `examples/setup.sh`

- [ ] **Step 1: Create the `examples/` directory if it doesn't exist**

```bash
mkdir -p examples
```

- [ ] **Step 2: Write `examples/setup.sh`**

```bash
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
```

- [ ] **Step 3: Make it executable (for convenience, not required — `bash` is invoked explicitly in `base-vm.ts`)**

```bash
chmod +x examples/setup.sh
```

- [ ] **Step 4: Build**

```bash
pnpm run build
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add examples/setup.sh
git commit -m "Add examples/setup.sh — Alcova toolchain as a user setup script"
```

---

## Task 6: Rewrite `lib/base-vm.ts` to minimal core + user setup

Shrink the base provisioner to exactly what the spec's core list says. Append two new phases: install `/opt/avm/helpers.sh` from the repo, then copy and execute `~/.avm/setup.sh` as root.

**Files:**
- Modify: `lib/base-vm.ts`

- [ ] **Step 1: Replace the entire file**

```ts
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
    cp ${vmHostAvmHome}/setup.sh /tmp/avm-user-setup.sh
    bash /tmp/avm-user-setup.sh
    rm /tmp/avm-user-setup.sh
  `);

  // --- Stop the VM (it's now a template) ---

  console.log(`==> Stopping ${BASE_VM_NAME} (ready as template)...`);
  await $`orb stop ${BASE_VM_NAME}`;
}
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

Expected: clean build. Nothing else imports `lib/base-vm.ts` except `cli/commands/provision.ts`, which still calls `provisionBaseVm()` — that signature is unchanged.

- [ ] **Step 3: Commit**

```bash
git add lib/base-vm.ts
git commit -m "Shrink lib/base-vm.ts to minimal core + run ~/.avm/setup.sh"
```

---

## Task 7: Update `cli/commands/provision.ts`

Drop the `LEGACY_BASE_VM_NAME` migration block and add a precondition check: if `~/.avm/setup.sh` doesn't exist, error out with a pointer to `examples/setup.sh`.

**Files:**
- Modify: `cli/commands/provision.ts`

- [ ] **Step 1: Replace the entire file**

```ts
import { defineCommand } from "citty";
import { $ } from "zx";
import { existsSync } from "node:fs";
import { BASE_VM_NAME, avmSetupScript, REPO_ROOT } from "../../lib/config.ts";
import { provisionBaseVm } from "../../lib/base-vm.ts";

interface OrbListEntry {
  name: string;
  state: string;
}

export const provisionCommand = defineCommand({
  meta: {
    name: "provision",
    description:
      "Create or rebuild the base VM template that agent sessions clone from.",
  },
  async run() {
    if (!existsSync(avmSetupScript)) {
      console.error(`Error: ${avmSetupScript} not found.`);
      console.error(
        `See examples/setup.sh in the avm repo for a starting point:`,
      );
      console.error(`  cp ${REPO_ROOT}/examples/setup.sh ${avmSetupScript}`);
      process.exit(1);
    }

    const result = await $`orb list -f json`.quiet();
    const entries = JSON.parse(result.stdout) as OrbListEntry[];

    const base = entries.find((e) => e.name === BASE_VM_NAME);
    if (base && base.state === "running") {
      console.error(
        `Error: ${BASE_VM_NAME} is running. Stop it first:\n` +
          `  orb stop ${BASE_VM_NAME}`,
      );
      process.exit(1);
    }

    if (base) {
      console.log(`==> Deleting existing ${BASE_VM_NAME}...`);
      await $`orb delete -f ${BASE_VM_NAME}`;
    }

    await provisionBaseVm();

    console.log();
    console.log(`Done. Base VM '${BASE_VM_NAME}' is provisioned and stopped.`);
    console.log(`Start an agent session: avm create --attach`);
  },
});
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

Expected: clean build. `LEGACY_BASE_VM_NAME` is still exported from `lib/config.ts` (we delete it in Task 12), but it's fine that nothing imports it anymore.

- [ ] **Step 3: Sanity check — run `avm provision` with a missing setup.sh**

Temporarily rename any existing `~/.avm/setup.sh` so the precondition trips:

```bash
[ -f ~/.avm/setup.sh ] && mv ~/.avm/setup.sh ~/.avm/setup.sh.bak
pnpm run dev provision
# Expected output:
#   Error: /Users/<you>/.avm/setup.sh not found.
#   See examples/setup.sh in the avm repo for a starting point:
#     cp <repo>/examples/setup.sh /Users/<you>/.avm/setup.sh
# Exit code: 1
echo "exit: $?"
[ -f ~/.avm/setup.sh.bak ] && mv ~/.avm/setup.sh.bak ~/.avm/setup.sh
```

- [ ] **Step 4: Commit**

```bash
git add cli/commands/provision.ts
git commit -m "Drop legacy migration, add ~/.avm/setup.sh precondition in provision"
```

---

## Task 8: Create `lib/session.ts` — shared session orchestration

`applySessionMounts` and `applyLockdown` live here, called by both `create` and `start`. This is where every fixed mount, user volume, file-holding mount, `avm-link` generation, and CLAUDE.md seed happens.

**Files:**
- Create: `lib/session.ts`

- [ ] **Step 1: Write the file**

```ts
import { $, path } from "zx";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
} from "node:fs";
import {
  avmFilesDir,
  avmMirrorsDir,
  avmSystemClaudeDir,
  avmSystemClaudeJsonFile,
  avmSystemDir,
  avmSystemGitConfigFile,
  avmSystemSshDir,
  avmVolumesDir,
  REPO_ROOT,
  vmHostAvmHome,
} from "./config.ts";
import {
  type AvmConfig,
  generateAvmLinkScript,
  type VolumeMount,
} from "./config-file.ts";
import { asRoot } from "./vm.ts";

// Path where `~/.avm/files/` is bind-mounted inside the VM. Chosen so it
// lives under the agent's home and is not touched by the lockdown of
// /mnt/mac and /Users.
const VM_FILES_DIR = "/home/agent/.avm-files";

/**
 * Ensure host-side `~/.avm/system/*` scaffolding exists for session VMs
 * that need to mount it. Creates directories and an empty claude.json if
 * missing so bind-mounts don't fail. Does NOT populate anything — users
 * provide their own credentials and claude state.
 */
export function ensureHostScaffolding(): void {
  const requiredDirs = [
    avmSystemDir,
    avmSystemSshDir,
    path.dirname(avmSystemGitConfigFile),
    avmSystemClaudeDir,
    avmMirrorsDir,
    avmVolumesDir,
    avmFilesDir,
  ];
  for (const dir of requiredDirs) {
    mkdirSync(dir, { recursive: true });
  }

  // The bind mount for ~/.claude.json is a file mount, so the file has to
  // exist on both sides. Create an empty one if missing.
  if (!existsSync(avmSystemClaudeJsonFile)) {
    closeSync(openSync(avmSystemClaudeJsonFile, "a"));
  }
}

/**
 * Seed `~/.avm/system/claude/CLAUDE.md` from `templates/vm-claude.md` if
 * the destination doesn't exist yet. Once seeded, the user owns the file;
 * the CLI never overwrites it.
 */
export function seedInVmClaudeMd(): void {
  const dest = path.join(avmSystemClaudeDir, "CLAUDE.md");
  if (existsSync(dest)) return;
  const template = path.join(REPO_ROOT, "templates", "vm-claude.md");
  if (existsSync(template)) {
    copyFileSync(template, dest);
  }
}

/**
 * Apply all session mounts to a running VM: fixed system mounts, the
 * `~/.avm/files` holding mount, user volume mounts from config.yaml, the
 * generated `avm-link` script, and the gitconfig copy. Idempotent — safe
 * to call on both fresh clones and on resumed VMs (where orb stop blew
 * the old mounts away).
 */
export async function applySessionMounts(
  vmName: string,
  config: AvmConfig,
): Promise<void> {
  ensureHostScaffolding();
  seedInVmClaudeMd();

  // --- Fixed system mounts ---

  console.log("==> Setting up bind-mounts...");
  await asRoot(
    vmName,
    `
    mkdir -p /home/agent/.ssh /home/agent/.claude /home/agent/mirrors ${VM_FILES_DIR}
    touch /home/agent/.claude.json

    mount --bind ${vmHostAvmHome}/system/credentials/ssh /home/agent/.ssh
    mount --bind ${vmHostAvmHome}/system/claude /home/agent/.claude
    mount --bind ${vmHostAvmHome}/system/claude.json /home/agent/.claude.json
    mount --bind ${vmHostAvmHome}/mirrors /home/agent/mirrors
    mount --bind ${vmHostAvmHome}/files ${VM_FILES_DIR}

    chown agent:agent /home/agent/.claude.json
    chown -R agent:agent /home/agent/.ssh /home/agent/.claude /home/agent/mirrors ${VM_FILES_DIR}
  `,
  );

  // --- Copy gitconfig (not a mount — it's a small identity file) ---

  console.log("==> Copying git config...");
  await asRoot(
    vmName,
    `
    if [ -f ${vmHostAvmHome}/system/credentials/git/.gitconfig ]; then
      cp ${vmHostAvmHome}/system/credentials/git/.gitconfig /home/agent/.gitconfig
      chown agent:agent /home/agent/.gitconfig
    else
      echo "    (no ~/.avm/system/credentials/git/.gitconfig — skipping)" >&2
    fi
  `,
  );

  // --- User volume mounts ---

  if (config.volumes.length > 0) {
    console.log("==> Applying user volume mounts...");
    for (const volume of config.volumes) {
      await applyVolumeMount(vmName, volume);
    }
  }

  // --- Generated avm-link ---

  console.log("==> Installing /usr/local/bin/avm-link...");
  const script = generateAvmLinkScript(config);
  await $({
    input: script,
  })`ssh root@${vmName}@orb "cat > /usr/local/bin/avm-link && chmod +x /usr/local/bin/avm-link"`;
}

/**
 * Bind-mount empty directories over /mnt/mac and /Users so the agent user
 * can't traverse back to the host filesystem. VirtioFS doesn't support
 * chmod, so this mask is the only reliable way to lock these down.
 */
export async function applyLockdown(vmName: string): Promise<void> {
  console.log("==> Locking down host mount...");
  await asRoot(
    vmName,
    `
    mkdir -p /tmp/empty-mnt /tmp/empty-users
    mount --bind /tmp/empty-mnt /mnt/mac
    mount --bind /tmp/empty-users /Users
  `,
  );
}

// ---------- Private helpers ----------

/** Apply a single user volume mount, resolving source and target paths. */
async function applyVolumeMount(
  vmName: string,
  volume: VolumeMount,
): Promise<void> {
  const hostSource = resolveVolumeSource(volume.source);
  const vmSource = volume.source.startsWith("/")
    ? volume.source
    : `${vmHostAvmHome}/volumes/${volume.source}`;
  const vmTarget = resolveVolumeTarget(volume.target);

  if (!existsSync(hostSource)) {
    console.warn(
      `    [warn] volume source missing: ${hostSource} — skipping mount to ${vmTarget}`,
    );
    return;
  }

  await asRoot(
    vmName,
    `
    mkdir -p "${vmTarget}"
    mount --bind "${vmSource}" "${vmTarget}"
    chown -R agent:agent "${vmTarget}" || true
  `,
  );
}

/** Resolve a host-side volume source (for existence checks). */
function resolveVolumeSource(source: string): string {
  if (source.startsWith("/")) return source;
  return path.join(avmVolumesDir, source);
}

/**
 * Resolve a volume target to an absolute path inside the VM.
 * - Absolute paths pass through.
 * - `~/` expands to `/home/agent/`.
 * - Relative paths are rooted at `/home/agent/`.
 */
function resolveVolumeTarget(target: string): string {
  if (target.startsWith("/")) return target;
  if (target.startsWith("~/")) return `/home/agent/${target.slice(2)}`;
  return `/home/agent/${target}`;
}
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

Expected: clean build. Nothing consumes `lib/session.ts` yet — Task 9 will.

- [ ] **Step 3: Commit**

```bash
git add lib/session.ts
git commit -m "Add lib/session.ts — shared session mount + lockdown orchestration"
```

---

## Task 9: Create `cli/commands/create.ts`

New command that owns the old create flow. Name resolution, existence check, `orb clone` + `orb start`, `applySessionMounts`, `applyLockdown`, optional attach.

**Files:**
- Create: `cli/commands/create.ts`

- [ ] **Step 1: Write the file**

```ts
import { defineCommand } from "citty";
import { $ } from "zx";
import { spawnSync } from "node:child_process";
import { BASE_VM_NAME } from "../../lib/config.ts";
import { loadAvmConfig } from "../../lib/config-file.ts";
import {
  applyLockdown,
  applySessionMounts,
  ensureHostScaffolding,
} from "../../lib/session.ts";
import {
  generateSessionName,
  listAvmVms,
  normalizeVmName,
  waitForSsh,
} from "../../lib/vm.ts";

export const createCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create and start a new agent VM.",
  },
  args: {
    name: {
      type: "positional",
      required: false,
      description:
        "Suffix for the VM name (avm- is prepended automatically). Random if omitted.",
    },
    attach: {
      type: "boolean",
      description: "After setup, exec into the VM via SSH.",
    },
  },
  async run({ args }) {
    const vmName = args.name
      ? normalizeVmName(args.name)
      : generateSessionName();

    const existing = await listAvmVms();
    if (existing.some((v) => v.name === vmName)) {
      console.error(
        `Error: VM ${vmName} already exists. ` +
          `Use 'avm start ${vmName.slice(4)}' to resume it, or ` +
          `'avm clean ${vmName.slice(4)}' to delete and recreate.`,
      );
      process.exit(1);
    }

    // Make sure host scaffolding (~/.avm/system/*, ~/.avm/mirrors, etc.)
    // exists before we try to bind-mount it into the VM.
    ensureHostScaffolding();

    const config = loadAvmConfig();

    console.log(`==> Cloning ${BASE_VM_NAME} -> ${vmName}...`);
    await $`orb clone ${BASE_VM_NAME} ${vmName}`;
    await $`orb start ${vmName}`;
    console.log("==> Waiting for SSH...");
    await waitForSsh(vmName);

    await applySessionMounts(vmName, config);
    await applyLockdown(vmName);

    console.log();
    console.log("Session ready.");
    console.log();
    console.log(`  SSH: ssh ${vmName}@orb`);
    console.log();

    if (args.attach) {
      console.log(`==> Attaching to ${vmName}...`);
      const result = spawnSync("ssh", ["-t", `${vmName}@orb`], {
        stdio: "inherit",
      });
      process.exit(result.status ?? 0);
    }
  },
});
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add cli/commands/create.ts
git commit -m "Add cli/commands/create.ts — new avm create command"
```

---

## Task 10: Rewrite `cli/commands/start.ts` as resume-only

`avm start` becomes required-arg, prefix-matched via `resolveVmByPrefix`, and delegates to `lib/session.ts`. No `--clone`, no `ALL_REPOS`, no `REPO_DEPS`.

**Files:**
- Modify: `cli/commands/start.ts` (full rewrite)

- [ ] **Step 1: Replace the entire file**

```ts
import { defineCommand } from "citty";
import { $ } from "zx";
import { spawnSync } from "node:child_process";
import { loadAvmConfig } from "../../lib/config-file.ts";
import { applyLockdown, applySessionMounts } from "../../lib/session.ts";
import {
  listAvmVms,
  resolveVmByPrefix,
  waitForSsh,
} from "../../lib/vm.ts";

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description: "Resume a stopped agent VM.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Short ID (or unique prefix) of the VM to resume.",
    },
    attach: {
      type: "boolean",
      description: "After setup, exec into the VM via SSH.",
    },
  },
  async run({ args }) {
    if (!args.id) {
      console.error(
        "Error: avm start requires a VM id. Use 'avm create' to start a new session.",
      );
      process.exit(1);
    }

    const vms = await listAvmVms();

    let vmName: string;
    let vmStatus: string;
    try {
      const { vm } = resolveVmByPrefix(args.id, vms);
      vmName = vm.name;
      vmStatus = vm.status;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      console.error(
        `Use 'avm list' to see sessions, or 'avm create <name>' to start a new one.`,
      );
      process.exit(1);
    }

    if (vmStatus === "running") {
      console.error(
        `Error: VM ${vmName} is already running. Use 'avm attach ${vmName.slice(4)}' to connect.`,
      );
      process.exit(1);
    }

    const config = loadAvmConfig();

    console.log(`==> Starting ${vmName}...`);
    await $`orb start ${vmName}`;
    console.log("==> Waiting for SSH...");
    await waitForSsh(vmName);

    // Bind mounts don't persist across orb stop, so every resume has to
    // redo them. This also regenerates /usr/local/bin/avm-link, so
    // config.yaml changes take effect on resume.
    await applySessionMounts(vmName, config);
    await applyLockdown(vmName);

    console.log();
    console.log("Session ready.");
    console.log();
    console.log(`  SSH: ssh ${vmName}@orb`);
    console.log();

    if (args.attach) {
      console.log(`==> Attaching to ${vmName}...`);
      const result = spawnSync("ssh", ["-t", `${vmName}@orb`], {
        stdio: "inherit",
      });
      process.exit(result.status ?? 0);
    }
  },
});
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

Expected: clean build. `start.ts` no longer imports `ALL_REPOS`, `GITHUB_ORG`, `REPO_DEPS`, `cacheDir`, `claudeDir`, `claudeJsonFile`, `credentialsDir`, `envsDir`, `mirrorsDir`, `templatesDir`, `vmHostPrefix`, or anything from `lib/mirrors.ts`.

- [ ] **Step 3: Commit**

```bash
git add cli/commands/start.ts
git commit -m "Rewrite avm start as resume-only with prefix matching"
```

---

## Task 11: Register `create` in `cli/avm.ts`

**Files:**
- Modify: `cli/avm.ts`

- [ ] **Step 1: Add the import and subcommand entry**

Replace the current file contents with:

```ts
import { defineCommand, runMain } from "citty";
import { listCommand } from "./commands/list.ts";
import { createCommand } from "./commands/create.ts";
import { startCommand } from "./commands/start.ts";
import { stopCommand } from "./commands/stop.ts";
import { cleanCommand } from "./commands/clean.ts";
import { attachCommand } from "./commands/attach.ts";
import { provisionCommand } from "./commands/provision.ts";

const main = defineCommand({
  meta: {
    name: "avm",
    description: "Manage agent VMs.",
  },
  subCommands: {
    list: listCommand,
    create: createCommand,
    start: startCommand,
    attach: attachCommand,
    stop: stopCommand,
    clean: cleanCommand,
    provision: provisionCommand,
  },
});

runMain(main);
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

Expected: clean build.

- [ ] **Step 3: Verify the subcommands show up**

```bash
pnpm run dev --help
```

Expected: output includes both `create` and `start` with their descriptions ("Create and start a new agent VM." and "Resume a stopped agent VM.").

```bash
pnpm run dev create --help
pnpm run dev start --help
```

Expected: both show their own arg/flag documentation, `create` with optional `name` + `--attach`, `start` with required `id` + `--attach`.

- [ ] **Step 4: Commit**

```bash
git add cli/avm.ts
git commit -m "Register avm create alongside avm start"
```

---

## Task 12: Delete legacy constants and `lib/mirrors.ts`

Now that nothing imports the Alcova-specific constants or the mirrors helper, delete them.

**Files:**
- Modify: `lib/config.ts`
- Delete: `lib/mirrors.ts`

- [ ] **Step 1: Delete the old constants from `lib/config.ts`**

Replace the whole file with the trimmed version:

```ts
import { path } from "zx";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const BASE_VM_NAME = "avm-base";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

// --- ~/.avm/ layout ---

export const AVM_HOME = path.join(os.homedir(), ".avm");

export const avmSystemDir = path.join(AVM_HOME, "system");
export const avmSystemSshDir = path.join(avmSystemDir, "credentials/ssh");
export const avmSystemGitConfigFile = path.join(
  avmSystemDir,
  "credentials/git/.gitconfig",
);
export const avmSystemClaudeDir = path.join(avmSystemDir, "claude");
export const avmSystemClaudeJsonFile = path.join(avmSystemDir, "claude.json");

export const avmMirrorsDir = path.join(AVM_HOME, "mirrors");
export const avmVolumesDir = path.join(AVM_HOME, "volumes");
export const avmFilesDir = path.join(AVM_HOME, "files");

export const avmConfigFile = path.join(AVM_HOME, "config.yaml");
export const avmSetupScript = path.join(AVM_HOME, "setup.sh");

/** VM-side pre-lockdown path that reaches `~/.avm` on the host. */
export const vmHostAvmHome = `/mnt/mac${AVM_HOME}`;
```

Removed: `LEGACY_BASE_VM_NAME`, `GITHUB_ORG`, `REPO_DEPS`, `ALL_REPOS`, `dataDir`, `mirrorsDir`, `credentialsDir`, `envsDir`, `cacheDir`, `claudeDir`, `claudeJsonFile`, `vmHostPrefix`.

- [ ] **Step 2: Delete `lib/mirrors.ts`**

```bash
git rm lib/mirrors.ts
```

- [ ] **Step 3: Build**

```bash
pnpm run build
```

Expected: clean build. If anything fails, it means a consumer of a deleted constant was missed — grep for the deleted names and fix before continuing:

```bash
# Run each; all should produce NO output.
```

- [ ] **Step 4: Double-check no dangling references remain**

Use the Grep tool (not `rg` via Bash) to search for each deleted symbol across the repo. Expected: no results in code. (Hits inside `docs/superpowers/specs/` or plan files are fine.)

Search for: `LEGACY_BASE_VM_NAME`, `GITHUB_ORG`, `REPO_DEPS`, `ALL_REPOS`, `dataDir`, `mirrorsDir`, `credentialsDir`, `envsDir`, `cacheDir`, `claudeDir`, `claudeJsonFile`, `vmHostPrefix`, `updateMirrors`, `ensureMirror`, `from "../../lib/mirrors"`, `from "./mirrors"`.

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts lib/mirrors.ts
git commit -m "Delete Alcova-specific constants and lib/mirrors.ts"
```

---

## Task 13: Rewrite `templates/vm-claude.md`

Generic in-VM CLAUDE.md seed. No Alcova references, no Go/Atlas/Task sections. Documents the standard paths, `avm-link`, `clauded`, and the `avm create` vs `avm start` split.

**Files:**
- Modify: `templates/vm-claude.md` (full rewrite)

- [ ] **Step 1: Replace the entire file**

```markdown
# avm Agent Environment

You are running inside an `avm` sandbox — an OrbStack Linux VM cloned
from the `avm-base` template. The host macOS filesystem is locked down
and not accessible from this VM. You have full autonomy within the
sandbox and are expected to run with `--dangerously-skip-permissions`
(use the `clauded` alias).

## Filesystem Layout

- `~/work/` — where project repos live. Clone new repos here.
- `~/mirrors/` — bare git mirrors, bind-mounted from the host. If a repo
  has a mirror at `~/mirrors/<name>.git`, reference-clone through it to
  save bandwidth and disk. If there's no mirror, clone directly from the
  remote.
- `~/.avm-files/` — read-only overlay files from the host. These are the
  sources behind the symlinks `avm-link` creates (env files, config
  overrides, etc.). You usually don't touch these directly — `avm-link`
  does.
- `~/.ssh/` — SSH keys and config, bind-mounted from the host. These are
  your GitHub credentials.
- `~/.claude/` and `~/.claude.json` — Claude Code home and settings,
  bind-mounted from the host. Shared across every avm session.
- `~/.gitconfig` — copied from the host at VM creation/resume.

## Cloning Repos

If a mirror exists, use it:

```
git clone --reference ~/mirrors/<name>.git \
  git@github.com:<owner>/<name>.git \
  ~/work/<name>
```

If there's no mirror (no `~/mirrors/<name>.git`), just clone normally:

```
git clone git@github.com:<owner>/<name>.git ~/work/<name>
```

Never pass `--dissociate`. Reference-clones keep a link to the mirror's
object database — that's the point. Never run `git gc` on mirrors from
inside the VM.

## Per-Repo Config: `avm-link`

After cloning a repo, run `avm-link` from inside the working copy:

```
cd ~/work/<name>
avm-link
```

`avm-link` reads the per-repo config the user declared in
`~/.avm/config.yaml` on the host and creates symlinks for env files,
config overrides, etc. It's generated per-VM at session startup, so
changes to `config.yaml` take effect on the next `avm create` or
`avm start`. Safe to re-run — uses `ln -sf`.

If the current directory name doesn't match a repo key in the config,
pass the name explicitly:

```
avm-link <name>
```

Repos that aren't in the config are a no-op — `avm-link` exits 0 without
doing anything.

## Claude Code

The `clauded` alias runs Claude Code with
`--dangerously-skip-permissions`. Use it freely — this is the whole
point of the sandbox.

## Persistence

Host-bind-mounted state survives VM stop/start/delete:

- `~/.ssh/`, `~/.claude/`, `~/.claude.json`, `~/.gitconfig`
- `~/mirrors/`, `~/.avm-files/`
- Whatever volumes the user declared in `~/.avm/config.yaml` (caches,
  package stores, build output, etc.)

Everything else in the VM is ephemeral. When the VM is deleted
(`avm clean <id>` on the host), anything under `~/work/` or `/tmp` is
gone. Commit and push work you care about.

Working copies under `~/work/` DO persist across `avm stop` + `avm start`
— stop just stops the VM; the filesystem isn't wiped. Only `avm clean`
deletes them.

## Host-Side Commands (for context, not for running here)

These are the host commands the user runs to manage VMs. You can't run
them from inside the VM; `avm` is host-side only.

- `avm create [name]` — create a new VM and start it
- `avm start <id>` — resume a stopped VM
- `avm stop <id>` — stop (without deleting) a running VM
- `avm attach <id>` — SSH back into a running VM
- `avm clean <id>` — stop and delete a VM (destroys `~/work/`)
- `avm list` — list all session VMs
```

- [ ] **Step 2: Commit**

```bash
git add templates/vm-claude.md
git commit -m "Rewrite templates/vm-claude.md as generic in-VM CLAUDE.md seed"
```

---

## Task 14: Update `README.md`

Reflect the new `~/.avm/` layout, the `avm create` / `avm start` split, and the `setup.sh`-based base VM customization.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the full README**

```markdown
# avm

A harness for running sandboxed Claude Code agents in OrbStack Linux VMs
with `--dangerously-skip-permissions`. Spin up a fresh, credential-loaded
workspace in a couple of seconds; tear it down when you're done.

## Why

Running Claude Code with `--dangerously-skip-permissions` on your host
machine is reckless — an unrestricted agent can read your credentials,
trash your filesystem, or do anything your user account can do.

`avm` gives agents full autonomy inside disposable, locked-down OrbStack
VMs. The agent thinks it has free rein. It does — inside a sandbox. The
host filesystem is bind-mount-masked after setup, credentials are
bind-mounted from `~/.avm/`, and repo clones, caches, and Claude Code
settings can be shared from the host so you don't lose state when a VM
is destroyed.

## Requirements

- macOS with [OrbStack](https://orbstack.dev/) installed
- Node 24+ (the CLI itself runs on the host)
- pnpm (via corepack or standalone)
- A GitHub SSH key and git identity

## Install

```bash
git clone <this repo>
cd avm
pnpm install
pnpm link --global
```

`pnpm install` runs a `prepare` script that bundles the CLI to
`dist/avm.mjs` via esbuild. `pnpm link --global` then symlinks `avm` into
your shell PATH. Run `avm --help` to confirm.

After pulling new changes, run `pnpm install` again (or `pnpm run
build`) to rebuild `dist/avm.mjs`. For iterative development, use `pnpm
run dev <command>` to run the CLI via `tsx` without a rebuild.

### (Optional) Install the Claude Code skill

This repo ships a skill at `skills/avm/` that teaches your host-side
Claude Code when and how to invoke `avm`. Symlink it into your
user-level skills directory:

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/avm" ~/.claude/skills/avm
```

The symlink keeps the skill in sync with `git pull`.

## First-Time Setup

`avm` keeps all user-owned state under `~/.avm/`. A fresh install starts
with no `~/.avm/` at all — you create the pieces you need. On a fresh
machine you can either walk through the steps below manually, or let
the host-side Claude skill guide you.

### 1. Seed host credentials

Create the system layout and drop in your SSH key and git identity:

```bash
mkdir -p ~/.avm/system/credentials/ssh
mkdir -p ~/.avm/system/credentials/git
mkdir -p ~/.avm/system/claude

cp ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub ~/.ssh/config ~/.avm/system/credentials/ssh/
cp ~/.gitconfig ~/.avm/system/credentials/git/.gitconfig
```

These are bind-mounted read-write into every VM. Claude Code state
(`~/.avm/system/claude/` and `~/.avm/system/claude.json`) fills itself
in the first time you run `claude` inside a VM — you can leave those
empty to start.

### 2. Create your setup script

`~/.avm/setup.sh` is where you install whatever toolchain your project
needs — Go, Python, Docker, language-specific CLIs, etc. It runs as
root inside the base VM during `avm provision` and can source
`/opt/avm/helpers.sh` for `as_agent` / `echo_step` helpers.

Copy the provided example to get started:

```bash
cp examples/setup.sh ~/.avm/setup.sh
```

Then edit `~/.avm/setup.sh` to match your stack. The example reproduces
a Go + Node + Docker environment; delete what you don't need.

### 3. Provision the base VM

```bash
avm provision
```

This creates the `avm-base` template: a stopped Ubuntu VM with a minimal
core (build tools, git, Node, Claude Code, `/opt/avm/helpers.sh`) plus
everything your `setup.sh` installs on top. Takes several minutes on
first run. If `avm-base` already exists and is stopped, it's deleted and
rebuilt from scratch; if it's running, the command errors out — stop it
first with `orb stop avm-base`.

`lib/base-vm.ts` owns the core; `~/.avm/setup.sh` owns the user layer.
If you need a new core tool (installed by the CLI for everyone), edit
the core. If you need a project-specific tool, edit your `setup.sh`.

### 4. (Optional) Declare mounts and per-repo symlinks

Create `~/.avm/config.yaml` to declare bind mounts and per-repo
symlinks. The file is optional — without it, VMs come up with system
mounts only.

```yaml
# ~/.avm/config.yaml

# Bind mounts applied to every session VM on `avm create` or `avm start`.
# source is relative to ~/.avm/volumes/
# target is relative to /home/agent/ (or absolute if starting with /)
volumes:
  - pnpm-store:~/.local/share/pnpm/store
  - go-build:~/.cache/go-build
  - cargo:~/.cargo

# Per-repo config, applied by `avm-link` inside the VM after the agent
# clones a repo. source is relative to ~/.avm/files/.
repos:
  operator-ui:
    symlinks:
      - envs/operator-ui.env:.env
  alcova-backend:
    symlinks:
      - envs/alcova-backend.env:.env
      - configs/alcova-backend/local.yml:config/local.yml
```

Populate the source directories alongside the config:

```bash
mkdir -p ~/.avm/volumes/pnpm-store ~/.avm/volumes/go-build ~/.avm/volumes/cargo
mkdir -p ~/.avm/files/envs ~/.avm/files/configs/alcova-backend
# ... drop your .env / config files into ~/.avm/files/
```

### 5. (Optional) Populate mirrors

For faster clones of large repos, create bare mirrors:

```bash
git clone --mirror git@github.com:<owner>/<repo>.git ~/.avm/mirrors/<repo>.git
```

Refresh with `git -C ~/.avm/mirrors/<repo>.git fetch --all --prune`. The
agent inside the VM can then `git clone --reference ~/mirrors/<repo>.git
...` for near-instant clones.

### 6. Start your first session

```bash
avm create --attach
```

This clones `avm-base` into a fresh session VM, applies your mounts,
installs `/usr/local/bin/avm-link`, locks down the host mount, and drops
you into an SSH shell.

## Commands

```
avm list                  # List all session VMs
avm create [name]         # Create and start a new session VM
  --attach                # Drop straight into the VM via SSH
avm start <id>            # Resume a stopped session VM
  --attach                # Drop straight into the VM via SSH
avm attach [id]           # SSH into a running VM (interactive picker if no id)
avm stop <id...>          # Stop one or more VMs without destroying them
  --all                   # Stop every running session VM
avm clean <id...>         # Stop and delete one or more VMs
  --all                   # Clean every session VM
avm provision             # Create or rebuild the avm-base template
```

IDs are the 5-char suffix after `avm-`. You can pass a prefix — if it
matches exactly one VM, it works; ambiguous prefixes print the list of
matches and exit. `avm clean` with a prefix prompts for confirmation.

Inside every VM, `clauded` is an alias for
`claude --dangerously-skip-permissions`, and `avm-link` applies the
per-repo symlinks declared in `~/.avm/config.yaml`.

## Host Data Layout

Everything under `~/.avm/` is user-owned local state. Nothing in the
repo is touched by `avm` at runtime except `templates/` and `examples/`,
which ship as part of the CLI.

```
~/.avm/
├── config.yaml           # user-edited: volumes + per-repo config (optional)
├── setup.sh              # user-written: base VM setup script (required for `avm provision`)
├── system/               # fixed layout; mounted into every session VM
│   ├── credentials/
│   │   ├── ssh/          # → ~/.ssh in VM (bind mount)
│   │   └── git/
│   │       └── .gitconfig # → ~/.gitconfig in VM (copied)
│   ├── claude/           # → ~/.claude in VM (bind mount)
│   └── claude.json       # → ~/.claude.json in VM (file bind mount)
├── mirrors/              # → ~/mirrors in VM (bind mount)
├── volumes/              # bind sources declared in config.yaml
└── files/                # symlink sources for avm-link (→ ~/.avm-files in VM)
```

## How `avm create` / `avm start` Work

Both commands share the same mount + lockdown orchestration in
`lib/session.ts`. The difference is just what happens first:

- **`avm create`** runs `orb clone avm-base <name>` + `orb start`, then
  applies mounts and lockdown.
- **`avm start`** runs `orb start <name>` (the VM already exists), then
  re-applies mounts and lockdown. Bind mounts don't persist across stop,
  so every resume has to redo them — which is why `config.yaml` changes
  take effect on resume.

Rough order of operations for both:

1. Resolve / generate the VM name.
2. Read `~/.avm/config.yaml` (tolerate absence).
3. `orb clone` (create only) + `orb start`, poll SSH until it's up.
4. Bind-mount `~/.avm/system/*`, `~/.avm/mirrors`, `~/.avm/files`, and
   every `volumes:` entry from `config.yaml`.
5. Copy `.gitconfig` to `/home/agent/.gitconfig`.
6. Seed `~/.avm/system/claude/CLAUDE.md` from `templates/vm-claude.md`
   if missing (never overwrites).
7. Generate `/usr/local/bin/avm-link` from `config.yaml`.
8. Lock down `/mnt/mac` and `/Users` with empty bind mounts.
9. Print the SSH command (or `exec` into it if `--attach`).

All bind mounts — including the ones under `system/credentials/` — are
established *before* the lockdown, and the lockdown only masks
`/mnt/mac` and `/Users`. The agent can't escape to the host, but it can
still read its SSH keys and write to the shared caches.

## Cloning Repos From Inside the VM

`avm create` and `avm start` deliberately don't clone repos. That's the
agent's job, inside the VM. The CLI's job is to make the tools
available: mirrors at `~/mirrors/`, overlay files at `~/.avm-files/`,
and `avm-link` on the PATH. The in-VM `CLAUDE.md` (seeded from
`templates/vm-claude.md`) tells the agent how to use them.

## Customizing

### Adding a toolchain package

Edit `~/.avm/setup.sh` and add the install command, then:

```bash
orb stop avm-base
avm provision
```

This rebuilds `avm-base`. Running session VMs are unaffected — they're
copy-on-write clones and don't share state with the template after
creation.

### Adding a per-repo config

Edit `~/.avm/config.yaml`:

```yaml
repos:
  my-new-service:
    symlinks:
      - envs/my-new-service.env:.env
```

Then drop `~/.avm/files/envs/my-new-service.env` in place. The next
`avm create` (or `avm start` on an existing VM) picks up the change.

### Customizing in-VM Claude behavior

`~/.avm/system/claude/CLAUDE.md` is loaded automatically by Claude Code
inside every VM. On first session creation it's seeded from
`templates/vm-claude.md`. Edit it freely afterwards — the seed is never
re-copied over an existing file.

## Architecture Notes

- **No state service.** `orb list -f json` is the source of truth. The
  CLI is a thin wrapper over `orb` and SSH.
- **VMs are reusable workspaces, not per-PR containers.** Name them
  whatever fits the way you work. Cleanup is manual.
- **No automated tests.** This is a CLI glue layer. Verification is
  manual: run the commands, check that things work.

## Troubleshooting

- **`avm provision` fails with "setup.sh not found"** — copy the
  example: `cp examples/setup.sh ~/.avm/setup.sh`, then edit it to fit
  your stack.
- **`avm provision` fails partway through your `setup.sh`** — the base
  VM is left half-built. Run `avm provision` again; it'll delete and
  rebuild from scratch.
- **Login doesn't persist across VMs** — make sure
  `~/.avm/system/claude.json` exists on the host. It's bind-mounted as
  a file into every VM; without it, Claude Code runs first-run setup
  every time. `avm create` creates an empty file if one isn't there.
- **`pnpm install` inside the VM is slow every time** — declare a
  pnpm-store volume in `~/.avm/config.yaml`:
  `- pnpm-store:~/.local/share/pnpm/store`, and create
  `~/.avm/volumes/pnpm-store/`.
- **`git clone` inside the VM is slow** — populate
  `~/.avm/mirrors/<repo>.git` with `git clone --mirror ...`, and have
  the agent use `git clone --reference ~/mirrors/<repo>.git ...`.
- **`avm create` fails with "VM already exists"** — that name is taken.
  Use `avm list` to see what's running; `avm start <id>` to resume, or
  `avm clean <id>` to free it up.
- **`avm start <id>` fails with "already running"** — the VM is already
  up. Use `avm attach <id>` to connect.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Rewrite README for ~/.avm/ layout and create/start split"
```

---

## Task 15: Update `CLAUDE.md`

Two changes only:
1. Swap the path-constant references so they point at `lib/config.ts`'s new paths.
2. Drop the `REPO_DEPS` / `data/envs/<repo>.env` references.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the file**

Find the "Project Principles" section. Replace this bullet:

```
- **`data/` is host-side state, gitignored.** Mirrors, credentials, env
  files, cache, Claude Code state — all live here. Never commit anything
  under `data/`.
- **`templates/` seeds `data/`.** Files under `templates/` are committed
  and canonical. `avm start` copies them into `data/` only if the target
  doesn't already exist, so users can customize freely without losing
  their edits on upgrade.
```

with:

```
- **`~/.avm/` is host-side state, user-owned.** Mirrors, credentials,
  env files, caches, Claude Code state, user setup script, and
  `config.yaml` all live under the user's home directory. The repo
  never reads or writes anything under `~/.avm/` at install time —
  users populate it themselves (see README "First-Time Setup").
- **`templates/` seeds `~/.avm/system/claude/`.** Files under
  `templates/` are committed and canonical. `avm create`/`avm start`
  copy `vm-claude.md` into `~/.avm/system/claude/CLAUDE.md` only if the
  target doesn't already exist, so users can customize freely without
  losing their edits on upgrade.
- **`examples/` ships user-facing starting points.** `examples/setup.sh`
  is the reference user setup script users copy to `~/.avm/setup.sh`.
```

Find the "File Structure" section and replace the block:

```
```
bin/avm.mjs                 # global entrypoint wrapper (for pnpm link)
cli/avm.ts                  # citty entrypoint, registers subcommands
cli/commands/*.ts           # one file per subcommand
lib/config.ts               # constants, paths, REPO_DEPS
lib/vm.ts                   # SSH helpers, orb wrappers, ID utilities
lib/mirrors.ts              # bare mirror management
lib/base-vm.ts              # source of truth for what's in the base VM template
templates/vm-claude.md      # seed for data/claude/CLAUDE.md
skills/avm/SKILL.md         # host-side Claude Code skill (symlinked in by users)
data/                       # host-side state, gitignored
docs/superpowers/           # design specs and implementation plans
```
```

with:

```
```
bin/avm.mjs                     # global entrypoint wrapper (for pnpm link)
cli/avm.ts                      # citty entrypoint, registers subcommands
cli/commands/*.ts               # one file per subcommand
lib/config.ts                   # paths + constants (AVM_HOME + derived)
lib/config-file.ts              # parse ~/.avm/config.yaml, generate avm-link
lib/session.ts                  # shared session mount + lockdown orchestration
lib/vm.ts                       # SSH helpers, orb wrappers, ID utilities
lib/base-vm.ts                  # minimal core provisioner; runs ~/.avm/setup.sh
templates/vm-claude.md          # seed for ~/.avm/system/claude/CLAUDE.md
templates/vm-helpers.sh         # installed at /opt/avm/helpers.sh in every base VM
examples/setup.sh               # reference ~/.avm/setup.sh
skills/avm/SKILL.md             # host-side Claude Code skill (symlinked in by users)
docs/superpowers/               # design specs and implementation plans
```
```

Find the "When Modifying" section. Replace:

```
- **Adding a new command:** add `cli/commands/<name>.ts`, wire it into
  `cli/avm.ts`. Follow the pattern of the existing commands — citty's
  `defineCommand`, positional args via `args._`, `@clack/prompts` for
  interactive input.
- **Changing mounts or VM setup:** edit `cli/commands/start.ts`. Any new
  mount should also be documented in the README's "Host Data Layout"
  section and the in-VM template at `templates/vm-claude.md`.
- **Changing the base VM image:** edit `lib/base-vm.ts`, then rebuild
  with `avm provision`. Don't try to mutate a running base VM — the
  script is the source of truth. The base VM must be stopped before
  `avm provision` will rebuild it.
- **Adding a repo to `REPO_DEPS`:** edit `lib/config.ts`. Any new primary
  repo gets its `.env` file at `data/envs/<repo>.env` on the host.
```

with:

```
- **Adding a new command:** add `cli/commands/<name>.ts`, wire it into
  `cli/avm.ts`. Follow the pattern of the existing commands — citty's
  `defineCommand`, positional args via `args._`, `@clack/prompts` for
  interactive input.
- **Changing mounts or VM setup:** edit `lib/session.ts`. Any new
  fixed mount should also be documented in the README's "Host Data
  Layout" section and the in-VM template at `templates/vm-claude.md`.
  User-configurable mounts belong in `~/.avm/config.yaml`, not in code.
- **Changing the base VM core:** edit `lib/base-vm.ts`, then rebuild
  with `avm provision`. Don't try to mutate a running base VM — the
  script is the source of truth. The base VM must be stopped before
  `avm provision` will rebuild it. For toolchain installs, edit
  `~/.avm/setup.sh` (your own, not `examples/setup.sh`) rather than
  `lib/base-vm.ts`.
- **Adding a per-repo config:** edit `~/.avm/config.yaml`. Drop the
  source files under `~/.avm/files/` (for symlinks) or
  `~/.avm/volumes/` (for bind mounts). Nothing in the repo changes.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md for ~/.avm/ layout and file structure"
```

---

## Task 16: Update `skills/avm/SKILL.md`

Reflect the command split, drop `--clone`, describe the new layout, and add a "First-time setup on a fresh machine" section for host-side Claude to walk the user through populating `~/.avm/`.

**Files:**
- Modify: `skills/avm/SKILL.md`

- [ ] **Step 1: Replace the file**

```markdown
---
name: avm
description: Use when the user asks to spin up, attach to, list, or clean up avm sandbox VMs — the CLI for managing OrbStack-based Claude Code sandboxes.
---

# Using `avm`

`avm` is a CLI (installed globally via `pnpm link --global` from this
repo) that manages sandboxed agent VMs on OrbStack. Use it when the
user wants to work inside a disposable Linux VM with full Claude Code
autonomy (`--dangerously-skip-permissions`).

## When to use this skill

Invoke this skill when the user says things like:
- "give me a sandbox / VM / workspace"
- "spin up an avm"
- "start a fresh VM to work on X"
- "list my VMs" / "what sandboxes are running"
- "clean up that VM" / "tear it down"
- "attach to the sandbox"
- "set up avm on this machine"

## Commands

```
avm list                  # Show all session VMs and their status
avm create [name]         # Create and start a new VM
  --attach                # Drop straight into the VM via SSH
avm start <id>            # Resume a stopped VM (required id; prefix match)
  --attach                # Drop straight into the VM via SSH
avm attach [id]           # SSH into a running VM; interactive picker if no id
avm stop <id...>          # Stop one or more VMs without destroying them
  --all                   # Stop every running session VM
avm clean <id...>         # Stop and delete one or more session VMs
  --all                   # Clean every session VM
avm provision             # Create or rebuild the avm-base template
```

The base VM `avm-base` is infrastructure — excluded from `avm list` and
never touched by `avm clean`. Rebuild it with `avm provision`.

IDs are the 5-char suffix after `avm-` (e.g. `k7xf2`). Prefixes work as
long as they're unambiguous. `avm clean` with a prefix prompts for
confirmation before deleting.

## `avm create` vs `avm start`

- **`avm create`** makes a *new* VM. Fails if the name already exists.
  Use for a fresh sandbox.
- **`avm start <id>`** resumes an *existing stopped* VM. Fails if the
  VM doesn't exist or is already running. Use to pick back up where a
  previous session left off — working copies under `~/work/` persist
  across stop/start.

## Typical Flows

### User wants a fresh sandbox

```
avm create --attach
```

`--attach` drops the user straight into an SSH session once setup is
done.

### User wants to resume a previous sandbox

```
avm list                  # find the id
avm start <id> --attach
```

Or if the VM is already running, use `avm attach <id>` instead.

### User wants a working copy of a specific repo inside the VM

Start the VM, attach, then clone + link from inside:

```
avm create --attach
# (inside the VM)
cd ~/work
git clone --reference ~/mirrors/<repo>.git \
  git@github.com:<owner>/<repo>.git \
  <repo>
cd <repo>
avm-link            # applies any symlinks declared in ~/.avm/config.yaml
```

`avm` doesn't clone repos for you — that's the agent's job inside the
VM. The CLI's job is to make the mirrors, overlay files, and `avm-link`
available.

### User wants to know what's running

```
avm list
```

### User is done with a sandbox

```
avm clean <id>        # stop and delete
# or
avm stop <id>         # stop but keep (resumable via `avm start <id>`)
```

## Inside the VM

Once attached, the user (or Claude inside the VM) sees:

- `~/work/` — project repos (you clone them here; persists across stop/start)
- `~/mirrors/` — bare git mirrors for fast clones (bind-mounted from host)
- `~/.avm-files/` — overlay files for `avm-link` to symlink from (read-only in practice)
- `~/.ssh/`, `~/.claude/`, `~/.claude.json`, `~/.gitconfig` — credentials and settings
- `clauded` — alias for `claude --dangerously-skip-permissions`
- `avm-link` — applies the per-repo symlinks from `~/.avm/config.yaml`

The host macOS filesystem is locked down after setup — `/mnt/mac` and
`/Users` are masked by empty bind-mounts. The agent can't escape.

## First-time setup on a fresh machine

If the user says "set up avm" or the CLI errors out because `~/.avm/`
is empty, walk them through populating it. Everything `avm` needs at
runtime lives under `~/.avm/`.

Minimum for a working session:

1. **SSH key and config** at `~/.avm/system/credentials/ssh/`. Offer to
   generate a new `id_ed25519` if they don't have one to dedicate to
   agent VMs, or copy an existing one from `~/.ssh/`. The directory is
   bind-mounted as `~/.ssh` inside every VM, so treat it as the agent's
   GitHub identity.
2. **Git identity** at `~/.avm/system/credentials/git/.gitconfig`.
   Either copy `~/.gitconfig` or write a minimal one with `user.name`
   and `user.email`.
3. **Setup script** at `~/.avm/setup.sh`. Start from
   `<avm-repo>/examples/setup.sh` (copy and edit). This is where the
   user specifies what toolchain they want in the base VM — Go, Docker,
   language runtimes, etc.
4. **Run `avm provision`** to build the base VM. Takes several minutes.
5. **Run `avm create --attach`** to start a session.

Optional but recommended:

- **Mirrors** at `~/.avm/mirrors/<repo>.git` via
  `git clone --mirror git@github.com:<owner>/<repo>.git
  ~/.avm/mirrors/<repo>.git`. Fast reference-clones inside every VM.
- **`~/.avm/config.yaml`** declaring bind-mount volumes (caches, package
  stores) and per-repo symlinks (env files, config overrides). See the
  README for the schema. Drop source files under `~/.avm/volumes/` and
  `~/.avm/files/`.

Don't create `~/.avm/` directories the user won't populate. Empty
scaffolding clutters their home; `avm create` creates the pieces it
needs on demand (`ensureHostScaffolding` in `lib/session.ts`).

## Things NOT to do

- **Don't create VMs by calling `orb` directly.** Always go through `avm
  create` so mounts, credentials, and lockdown are set up correctly.
- **Don't ask the user which repo or branch to use before starting a
  VM.** `avm create` intentionally doesn't take a repo. The user (or
  Claude inside the VM) picks that once they're inside.
- **Don't auto-clean VMs.** Cleanup is the user's decision. The only
  cleanup command is `avm clean`.
- **Don't run the CLI from inside a VM.** `avm` is host-side only — it
  controls OrbStack from macOS. Inside a VM, the user just works with
  the repos directly.
- **Don't edit `examples/setup.sh` in the repo.** That's the shipped
  example. User customizations go in their own `~/.avm/setup.sh`.

## If something goes wrong

- **`avm provision` fails with "setup.sh not found"**: copy the example
  first — `cp examples/setup.sh ~/.avm/setup.sh` — then rerun.
- **`avm provision` fails partway through `setup.sh`**: the base VM is
  left half-built. Rerun `avm provision` — it'll delete and rebuild.
- **`avm create` fails because a VM already exists**: `avm list` and
  either `avm clean` the old one or pass a different name, or
  `avm start <id>` if the user wants to resume it.
- **`avm start <id>` fails with "already running"**: use
  `avm attach <id>` instead.
- **SSH doesn't come up within 30s**: likely an OrbStack issue. The VM
  is left running for debugging. Check `orb list` and
  `orb logs <vmName>`.
- **Claude Code inside the VM runs onboarding every time**: check that
  `~/.avm/system/claude.json` exists on the host.
```

- [ ] **Step 2: Commit**

```bash
git add skills/avm/SKILL.md
git commit -m "Update avm skill for create/start split and ~/.avm/ layout"
```

---

## Task 17: End-to-end manual verification

This is the real verification that the refactor works. The build has been green at every commit, but none of that proves the CLI actually spins up a VM.

**Files:** (none — this is host-side testing)

**Preconditions:**
- Any previous `alcova-base` / `avm-base` VM should be stopped or deleted — the spec explicitly calls out no migration, so clean slate is expected.
- `~/.avm/` may or may not exist yet. The verification below populates it.

- [ ] **Step 1: Delete any existing base/session VMs**

```bash
orb list
# For each avm-* VM that exists:
#   orb stop <name>
#   orb delete -f <name>
```

- [ ] **Step 2: Seed `~/.avm/system/` with credentials**

```bash
mkdir -p ~/.avm/system/credentials/ssh
mkdir -p ~/.avm/system/credentials/git
mkdir -p ~/.avm/system/claude

# Copy (or generate) an SSH key for the VMs:
cp ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub ~/.avm/system/credentials/ssh/
# And a minimal ssh config if you have one.
cp ~/.ssh/config ~/.avm/system/credentials/ssh/ 2>/dev/null || true

# Git identity:
cp ~/.gitconfig ~/.avm/system/credentials/git/.gitconfig
```

- [ ] **Step 3: Seed `~/.avm/setup.sh` from the example**

```bash
cp examples/setup.sh ~/.avm/setup.sh
```

- [ ] **Step 4: Run `avm provision`**

```bash
avm provision
```

Expected:
- Prints `==> Creating avm-base...`, `==> Installing core system packages...`, through to `==> Running user setup.sh...`.
- `setup.sh` output includes `==>` lines from `echo_step` (Installing Go, Docker, etc.).
- Ends with `Done. Base VM 'avm-base' is provisioned and stopped.`
- `orb list` shows `avm-base` in `stopped` state.

If `setup.sh` fails, the base VM is left in a bad state — fix the error, delete `avm-base` (`orb delete -f avm-base`), and rerun.

- [ ] **Step 5: Create a session VM**

```bash
avm create test-session
```

Expected:
- `==> Cloning avm-base -> avm-test-session...`
- `==> Waiting for SSH...`
- `==> Setting up bind-mounts...`
- `==> Copying git config...`
- `==> Installing /usr/local/bin/avm-link...`
- `==> Locking down host mount...`
- `Session ready.` followed by the SSH command.

- [ ] **Step 6: Attach and verify mounts**

```bash
ssh avm-test-session@orb
```

Inside the VM, run:

```bash
# Fixed mounts
ls -la ~/.ssh             # should contain your SSH key
cat ~/.gitconfig          # should match the host's
ls -la ~/.claude          # should exist (may be empty)
ls ~/mirrors              # should exist (may be empty if no mirrors set up)
ls -la ~/.avm-files       # should exist (may be empty)

# avm-link is present and minimally valid
which avm-link
bash -x avm-link nonexistent-repo  # should exit 0 with no action

# Lockdown: /mnt/mac and /Users should be empty masks
ls /mnt/mac
ls /Users

# Claude Code is installed
which claude
# clauded alias is in place (open a fresh bash -l to pick up .bashrc)
bash -lc 'type clauded'

# Anything from your setup.sh is installed (e.g. Go from the example):
which go || echo "no go — check setup.sh output"
```

- [ ] **Step 7: Test `avm-link` with a real config**

Exit the VM. On the host:

```bash
mkdir -p ~/.avm/files/envs
echo "FOO=bar" > ~/.avm/files/envs/test-repo.env

cat > ~/.avm/config.yaml <<'EOF'
repos:
  test-repo:
    symlinks:
      - envs/test-repo.env:.env
EOF
```

`avm start` the VM (it's running — we need to re-apply mounts to pick up the config change). Actually simpler: `avm stop test-session && avm start test-session`.

```bash
avm stop test-session
avm start test-session --attach
```

Expected on start: same mount output as create, plus `==> Installing /usr/local/bin/avm-link...` regenerating the script.

Inside the VM:

```bash
mkdir -p ~/work/test-repo
cd ~/work/test-repo
avm-link
cat .env                  # should print FOO=bar via the symlink
ls -la .env               # should be a symlink to /home/agent/.avm-files/envs/test-repo.env
```

- [ ] **Step 8: Test `avm list`, `avm stop`, `avm start` with prefix, and `avm clean`**

Exit the VM. On the host:

```bash
avm list
# Expected: one row for avm-test-session, status running.

avm stop test-se          # partial prefix should work
avm list
# Expected: avm-test-session status stopped.

avm start test            # unambiguous prefix should resume
avm list
# Expected: avm-test-session status running again.

avm stop test-session
avm clean test-session
# Expected: prompts for confirmation only if the input is a partial prefix;
# exact match skips the prompt. Answer yes; VM is deleted.

avm list
# Expected: No agent VMs.
```

- [ ] **Step 9: Error path: `avm start` on a running VM**

```bash
avm create err-test --attach &
# wait for SSH ready, exit the shell
avm start err-test
# Expected: Error: VM avm-err-test is already running. Use 'avm attach err-test' to connect.
avm clean err-test
```

- [ ] **Step 10: Error path: `avm start` with nothing**

```bash
avm start nonexistent
# Expected: Error: No VM matching "nonexistent".
#           Use 'avm list' to see sessions, or 'avm create <name>' to start a new one.
```

- [ ] **Step 11: Error path: `avm provision` without a setup.sh**

```bash
mv ~/.avm/setup.sh ~/.avm/setup.sh.bak
avm provision
# Expected: Error: /Users/<you>/.avm/setup.sh not found. ...
mv ~/.avm/setup.sh.bak ~/.avm/setup.sh
```

- [ ] **Step 12: Error path: typo in config.yaml**

```bash
cp ~/.avm/config.yaml ~/.avm/config.yaml.bak

cat > ~/.avm/config.yaml <<'EOF'
volume:
  - pnpm-store:~/.local/share/pnpm/store
EOF

avm create typo-test
# Expected: Error parsing ~/.avm/config.yaml: unknown top-level key "volume". Allowed: volumes, repos.

mv ~/.avm/config.yaml.bak ~/.avm/config.yaml
```

- [ ] **Step 13: Report results**

If every step above produces the expected output, the refactor is verified end-to-end. If anything deviates:
1. Identify which task introduced the divergence (the commits are small enough to bisect quickly).
2. Fix in a new commit — don't amend past commits.
3. Rerun from the deviating step.

**No commit for this task** — it's verification, not code change. If the verification surfaces bugs and you fix them, those are separate commits with descriptive messages ("fix: avm-link target quoting", etc.).

---

## Completion

When all 17 tasks are done and Task 17 verification passes:

1. The repo no longer references Alcova-specific toolchains, repos, org, or paths.
2. `~/.avm/` is the sole home for user state.
3. `avm create` / `avm start` is the new command surface.
4. `avm-link` is the single source of truth for per-repo symlinks.
5. The design spec at `docs/superpowers/specs/2026-04-10-avm-generalization-design.md` matches reality.

Consider: at this point it's worth running `superpowers:requesting-code-review` against the full diff to catch anything the plan missed, and updating the spec's "Status" header from `Design` to `Implemented` with today's date.
