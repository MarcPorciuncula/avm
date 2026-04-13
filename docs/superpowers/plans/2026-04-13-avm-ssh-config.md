# `avm ssh-config` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `avm ssh-config` (sync/install/uninstall) so users can type `ssh avm-<id>` directly, backed by a managed `~/.avm/ssh_config` file and an `Include` line added to `~/.ssh/config` only with explicit consent. Persist the user's choice in a new `~/.avm/state.json`.

**Architecture:** New `lib/ssh-config.ts` (render file + mutate `~/.ssh/config` within marker block) and `lib/state.ts` (JSON state). New `cli/commands/ssh-config.ts` exposing `sync`/`install`/`uninstall` via citty. `create` triggers sync + a first-run prompt; `clean` triggers sync. No tests — manual end-to-end verification per project convention.

**Tech Stack:** TypeScript, citty, google/zx, `@clack/prompts`, Node fs (atomic write via `fs.rename`). Reads existing `listAvmVms()` output; no new deps.

---

## Ground Rules for This Plan

- **No automated tests.** Per `CLAUDE.md`: "No automated tests. This is a CLI glue layer; the valuable verification is running the commands end-to-end." Each task ends with a real command.
- **Every code task ends with `pnpm run build`.** That's the only automated gate.
- **Commit after every task.** Small, reviewable diffs.
- **Reference the spec.** The spec at `docs/superpowers/specs/2026-04-13-avm-ssh-config-design.md` is the source of truth for intent; this plan owns sequencing and exact code.
- **Additive-first ordering.** Library code lands before command wiring; command wiring lands before integration into `create`/`clean`.

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `lib/state.ts` | Read/write `~/.avm/state.json` with shallow merge per top-level key |
| `lib/ssh-config.ts` | Render `~/.avm/ssh_config`; install/uninstall Include line in `~/.ssh/config` |
| `cli/commands/ssh-config.ts` | citty command exposing `sync` (default), `install`, `uninstall` |

**Modified files:**

| Path | Changes |
|---|---|
| `lib/config.ts` | Add `avmSshConfigFile` and `avmStateFile` path constants |
| `cli/avm.ts` | Register `ssh-config` subcommand |
| `cli/commands/create.ts` | Call `syncSshConfig()`; run first-run install prompt |
| `cli/commands/clean.ts` | Call `syncSshConfig()` after containers are removed |
| `README.md` | Document `avm ssh-config` and first-time setup |
| `skills/avm/SKILL.md` | Describe the `ssh avm-<id>` shortcut and command group |

---

## Task 1: Add path constants

**Files:**
- Modify: `lib/config.ts`

- [ ] **Step 1: Add `avmSshConfigFile` and `avmStateFile` near the other `~/.avm/` paths**

In `lib/config.ts`, after the existing `avmConfigFile` export (around line 40), add:

```ts
export const avmSshConfigFile = path.join(AVM_HOME, "ssh_config");
export const avmStateFile = path.join(AVM_HOME, "state.json");
```

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/config.ts
git commit -m "Add avmSshConfigFile and avmStateFile path constants"
```

---

## Task 2: Create `lib/state.ts`

**Files:**
- Create: `lib/state.ts`

- [ ] **Step 1: Write `lib/state.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { avmStateFile } from "./config.ts";

export interface AvmState {
  sshConfig?: {
    /** Set when the user has answered the first-run install prompt. */
    installPrompt?: "installed" | "declined";
  };
}

/** Read `~/.avm/state.json`. Returns `{}` if missing or malformed. */
export function readState(): AvmState {
  try {
    const raw = readFileSync(avmStateFile, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge `partial` into the current state and persist. Shallow-merges each
 * top-level key, so callers can update one subsection without clobbering
 * unrelated state.
 */
export function updateState(partial: AvmState): AvmState {
  const current = readState();
  const next: AvmState = { ...current };
  for (const [key, value] of Object.entries(partial)) {
    const k = key as keyof AvmState;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      next[k] = { ...(current[k] ?? {}), ...value } as AvmState[typeof k];
    } else {
      next[k] = value as AvmState[typeof k];
    }
  }
  mkdirSync(dirname(avmStateFile), { recursive: true });
  const tmp = `${avmStateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, avmStateFile);
  return next;
}
```

Notes:
- Writes via temp file + rename so an interrupted write can't truncate state.
- File mode `0o600` because this may contain preferences the user considers personal.

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add lib/state.ts
git commit -m "Add lib/state.ts for persisted user preferences"
```

---

## Task 3: Create `lib/ssh-config.ts` — render function

**Files:**
- Create: `lib/ssh-config.ts`

- [ ] **Step 1: Write the initial file with the render function**

```ts
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { avmSshConfigFile } from "./config.ts";
import { listAvmVms, type VmInfo } from "./vm.ts";

const MANAGED_BANNER =
  "# Managed by avm. Do not edit — regenerated by `avm ssh-config sync`.";

/** Render the full contents of `~/.avm/ssh_config` from the given VMs. */
export function renderManagedFile(vms: VmInfo[]): string {
  const blocks: string[] = [];
  for (const vm of vms) {
    if (vm.sshPort == null) continue;
    blocks.push(
      [
        `Host ${vm.name}`,
        `  HostName localhost`,
        `  Port ${vm.sshPort}`,
        `  User agent`,
        `  StrictHostKeyChecking no`,
        `  UserKnownHostsFile /dev/null`,
      ].join("\n"),
    );
  }
  const body = blocks.length > 0 ? blocks.join("\n\n") + "\n" : "";
  return `${MANAGED_BANNER}\n\n${body}`;
}

/** Write `~/.avm/ssh_config` from the current set of avm containers. */
export async function syncSshConfig(): Promise<void> {
  const vms = await listAvmVms();
  const contents = renderManagedFile(vms);
  mkdirSync(dirname(avmSshConfigFile), { recursive: true });
  const tmp = `${avmSshConfigFile}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o644 });
  renameSync(tmp, avmSshConfigFile);
}
```

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add lib/ssh-config.ts
git commit -m "Add lib/ssh-config.ts with managed-file renderer and sync"
```

---

## Task 4: Add install/uninstall to `lib/ssh-config.ts`

**Files:**
- Modify: `lib/ssh-config.ts`

- [ ] **Step 1: Add install/uninstall + marker helpers**

Update the imports at the top of `lib/ssh-config.ts` to add `existsSync` from `node:fs`, `join` from `node:path`, and `os`:

```ts
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { avmSshConfigFile } from "./config.ts";
import { listAvmVms, type VmInfo } from "./vm.ts";
```

Then append the following to the bottom of the file:

```ts
const MARKER_START = "# >>> avm managed >>>";
const MARKER_END = "# <<< avm managed <<<";
const INCLUDE_LINE = "Include ~/.avm/ssh_config";

/** Absolute path to the user's SSH config file. */
function userSshConfigPath(): string {
  return join(os.homedir(), ".ssh", "config");
}

/** Build the marker block to prepend. */
function markerBlock(): string {
  return `${MARKER_START}\n${INCLUDE_LINE}\n${MARKER_END}\n`;
}

/** True if the file already has our marker block. */
function hasMarkerBlock(text: string): boolean {
  return text.includes(MARKER_START) && text.includes(MARKER_END);
}

/** True if the file has a bare Include line the user added themselves. */
function hasBareInclude(text: string): boolean {
  if (hasMarkerBlock(text)) return false;
  return text
    .split("\n")
    .some((line) => line.trim() === INCLUDE_LINE);
}

/** Read the user's SSH config (empty string if missing). */
function readUserSshConfig(): string {
  const p = userSshConfigPath();
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Write the user's SSH config atomically, creating `~/.ssh` if needed. */
function writeUserSshConfig(contents: string): void {
  const p = userSshConfigPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, p);
}

export interface InstallResult {
  /** "installed" → we wrote the marker block. "already" → a marker block or user-added Include was already present. */
  status: "installed" | "already";
}

/**
 * Ensure `~/.ssh/config` includes the avm-managed file. Idempotent.
 * Also ensures `~/.avm/ssh_config` exists by calling `syncSshConfig()`.
 */
export async function installInclude(): Promise<InstallResult> {
  await syncSshConfig();
  const current = readUserSshConfig();
  if (hasMarkerBlock(current)) return { status: "already" };
  if (hasBareInclude(current)) return { status: "already" };
  const next = markerBlock() + (current.length > 0 ? "\n" + current : "");
  writeUserSshConfig(next);
  return { status: "installed" };
}

export interface UninstallResult {
  status: "uninstalled" | "not-installed";
}

/**
 * Remove avm's marker block from `~/.ssh/config`. Leaves `~/.avm/ssh_config`
 * in place and never touches Include lines outside the marker block.
 */
export async function uninstallInclude(): Promise<UninstallResult> {
  const current = readUserSshConfig();
  if (!hasMarkerBlock(current)) return { status: "not-installed" };
  const lines = current.split("\n");
  const start = lines.findIndex((l) => l.trim() === MARKER_START);
  const end = lines.findIndex((l) => l.trim() === MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    return { status: "not-installed" };
  }
  // Drop marker block and a single trailing blank line if present.
  let removeEnd = end + 1;
  if (lines[removeEnd] === "") removeEnd += 1;
  lines.splice(start, removeEnd - start);
  writeUserSshConfig(lines.join("\n"));
  return { status: "uninstalled" };
}
```

Notes on detection logic:
- `hasBareInclude` only matches exact whitespace-trimmed equality so we don't accidentally match commented-out or differently-pathed Include lines.
- We don't try to preserve alternate include paths (e.g., absolute paths, `~/foo/ssh_config`) — if the user put a non-standard Include, `install` treats them as already-installed and does nothing.

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add lib/ssh-config.ts
git commit -m "Add installInclude/uninstallInclude with marker-block safety"
```

---

## Task 5: Create `cli/commands/ssh-config.ts`

**Files:**
- Create: `cli/commands/ssh-config.ts`

- [ ] **Step 1: Write the subcommand group**

```ts
import { defineCommand } from "citty";
import {
  installInclude,
  syncSshConfig,
  uninstallInclude,
} from "../../lib/ssh-config.ts";
import { updateState } from "../../lib/state.ts";

const syncSub = defineCommand({
  meta: {
    name: "sync",
    description: "Regenerate ~/.avm/ssh_config from current containers.",
  },
  async run() {
    await syncSshConfig();
    console.log("Wrote ~/.avm/ssh_config.");
  },
});

const installSub = defineCommand({
  meta: {
    name: "install",
    description: "Add an Include line to ~/.ssh/config (idempotent).",
  },
  async run() {
    const result = await installInclude();
    updateState({ sshConfig: { installPrompt: "installed" } });
    if (result.status === "installed") {
      console.log("Installed Include in ~/.ssh/config.");
      console.log("You can now run: ssh avm-<id>");
    } else {
      console.log("Already installed — ~/.ssh/config already includes avm's config.");
    }
  },
});

const uninstallSub = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove the avm-managed Include block from ~/.ssh/config.",
  },
  async run() {
    const result = await uninstallInclude();
    // Clear the prompt decision so a future `install` (or `create` prompt) works cleanly.
    updateState({ sshConfig: { installPrompt: undefined } });
    if (result.status === "uninstalled") {
      console.log("Removed avm Include block from ~/.ssh/config.");
    } else {
      console.log("Nothing to uninstall — no avm Include block found.");
    }
  },
});

export const sshConfigCommand = defineCommand({
  meta: {
    name: "ssh-config",
    description: "Manage the avm-generated SSH config.",
  },
  subCommands: {
    sync: syncSub,
    install: installSub,
    uninstall: uninstallSub,
  },
  // Default when called with no subcommand: sync.
  async run() {
    await syncSshConfig();
    console.log("Wrote ~/.avm/ssh_config.");
  },
});
```

Note on `updateState` in uninstall: setting `installPrompt: undefined` in a shallow merge leaves a `{ sshConfig: { installPrompt: undefined } }` key in JSON. That's acceptable — `readState()` treats it the same as absent. If this feels wrong during implementation, adjust `updateState` to strip undefined values; out of scope for this task.

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add cli/commands/ssh-config.ts
git commit -m "Add avm ssh-config command (sync/install/uninstall)"
```

---

## Task 6: Register `ssh-config` in `cli/avm.ts`

**Files:**
- Modify: `cli/avm.ts`

- [ ] **Step 1: Import and register the subcommand**

Add the import alongside the others:

```ts
import { sshConfigCommand } from "./commands/ssh-config.ts";
```

Add to `subCommands` (alphabetical order preferred; place after `ssh`):

```ts
    ssh: sshCommand,
    "ssh-config": sshConfigCommand,
```

- [ ] **Step 2: Build**

Run: `pnpm run build`
Expected: build succeeds.

- [ ] **Step 3: Smoke-test the new command surface**

Run:
```bash
node ./bin/avm.mjs ssh-config --help
```
Expected: help output listing `sync`, `install`, `uninstall` subcommands.

Run:
```bash
node ./bin/avm.mjs ssh-config sync
```
Expected: prints `Wrote ~/.avm/ssh_config.` and the file exists with the banner comment and a Host block per running container.

- [ ] **Step 4: Inspect the generated file**

Run: `cat ~/.avm/ssh_config`
Expected: banner line, then one `Host avm-<id>` block per container with non-null `sshPort`, matching the format from the spec. Pre-SSH-era containers (if any) are absent.

- [ ] **Step 5: Commit**

```bash
git add cli/avm.ts
git commit -m "Register ssh-config subcommand"
```

---

## Task 7: Wire `sync` into `clean`

**Files:**
- Modify: `cli/commands/clean.ts`

- [ ] **Step 1: Import `syncSshConfig`**

Add at the top:

```ts
import { syncSshConfig } from "../../lib/ssh-config.ts";
```

- [ ] **Step 2: Call it after the removal loop**

After the `for (const target of targets) { ... }` loop ends (i.e. just before the `run` closure ends), add:

```ts
    await syncSshConfig();
```

- [ ] **Step 3: Build**

Run: `pnpm run build`
Expected: build succeeds.

- [ ] **Step 4: End-to-end check**

Create a disposable container, then clean it:
```bash
node ./bin/avm.mjs create testclean
node ./bin/avm.mjs ssh-config sync
grep -c "Host avm-testclean" ~/.avm/ssh_config
# Expected: 1
node ./bin/avm.mjs clean testclean
grep -c "Host avm-testclean" ~/.avm/ssh_config
# Expected: 0
```

- [ ] **Step 5: Commit**

```bash
git add cli/commands/clean.ts
git commit -m "Sync ~/.avm/ssh_config after cleaning containers"
```

---

## Task 8: Wire `sync` + first-run prompt into `create`

**Files:**
- Modify: `cli/commands/create.ts`

- [ ] **Step 1: Add imports**

Add alongside existing imports:

```ts
import { select, isCancel } from "@clack/prompts";
import { installInclude, syncSshConfig } from "../../lib/ssh-config.ts";
import { readState, updateState } from "../../lib/state.ts";
```

Note: `@clack/prompts` is already used elsewhere (see `cli/commands/clean.ts`). `select` may not be imported yet in this file — adding it is safe.

- [ ] **Step 2: Call `syncSshConfig()` after post-creation setup**

After `await applyPostCreationSetup(vmName, config);` and before the `console.log("Session ready.")` block, insert:

```ts
    await syncSshConfig();
```

- [ ] **Step 3: Add the first-run prompt**

Immediately after the `syncSshConfig()` call (still before `console.log("Session ready.")`), add:

```ts
    const state = readState();
    if (state.sshConfig?.installPrompt === undefined) {
      const choice = await select({
        message:
          "Enable `ssh avm-<id>` shortcut by adding an Include to ~/.ssh/config?",
        options: [
          { value: "yes", label: "Yes, install it" },
          { value: "later", label: "Not now (ask again next time)" },
          { value: "never", label: "No, don't ask again" },
        ],
        initialValue: "yes",
      });
      if (!isCancel(choice)) {
        if (choice === "yes") {
          const result = await installInclude();
          updateState({ sshConfig: { installPrompt: "installed" } });
          if (result.status === "installed") {
            console.log("Installed Include in ~/.ssh/config.");
          } else {
            console.log("~/.ssh/config already includes avm's config.");
          }
        } else if (choice === "never") {
          updateState({ sshConfig: { installPrompt: "declined" } });
        }
        // "later" → no state change
      }
    }
```

Placement matters: this runs **after** the container is ready but **before** we print the "Session ready" banner, so the prompt appears once and the final attach/ssh flags still work afterwards.

- [ ] **Step 4: Build**

Run: `pnpm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual verify — prompt path**

First, clear any existing state to force the prompt:
```bash
rm -f ~/.avm/state.json
```

Create a disposable container:
```bash
node ./bin/avm.mjs create promptcheck
```

Expected: you see the three-option prompt. Choose "Not now". Then:
```bash
cat ~/.avm/state.json 2>/dev/null || echo "no state file (expected for 'later')"
```

Re-run create on another container:
```bash
node ./bin/avm.mjs create promptcheck2
```
Expected: prompt appears again (because "later" didn't persist).

- [ ] **Step 6: Manual verify — decline path**

When re-prompted, choose "No, don't ask again". Confirm:
```bash
cat ~/.avm/state.json
# Expected: {"sshConfig":{"installPrompt":"declined"}}
```

Create another container:
```bash
node ./bin/avm.mjs create promptcheck3
```
Expected: **no prompt**.

- [ ] **Step 7: Manual verify — install path**

Reset state and try the install path:
```bash
rm -f ~/.avm/state.json
node ./bin/avm.mjs create promptcheck4
# Choose "Yes, install it"
grep -A1 ">>> avm managed >>>" ~/.ssh/config
# Expected: marker block with `Include ~/.avm/ssh_config`
cat ~/.avm/state.json
# Expected: {"sshConfig":{"installPrompt":"installed"}}
```

Test the end-user experience:
```bash
ssh avm-promptcheck4 echo hello
# Expected: prints "hello" after SSH host-key noise
```

- [ ] **Step 8: Clean up test containers**

```bash
node ./bin/avm.mjs clean promptcheck promptcheck2 promptcheck3 promptcheck4
```

- [ ] **Step 9: Uninstall path check**

```bash
node ./bin/avm.mjs ssh-config uninstall
grep -c "avm managed" ~/.ssh/config || true
# Expected: 0
cat ~/.avm/state.json
# Expected: no installPrompt key (either file absent or object empty after the merge)
```

- [ ] **Step 10: Commit**

```bash
git add cli/commands/create.ts
git commit -m "Sync ssh_config and offer Include install on avm create"
```

---

## Task 9: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Extend the `## Commands` code block**

In the code block under `## Commands` (currently around lines 174–193), add the following lines after `avm clean` and before `avm provision`:

```
avm ssh-config            # Regenerate ~/.avm/ssh_config from current containers
avm ssh-config install    # Add Include line to ~/.ssh/config (enables `ssh avm-<id>`)
avm ssh-config uninstall  # Remove the Include line
```

- [ ] **Step 2: Add a short explanatory paragraph**

After the paragraph beginning "Inside every container, `clauded` is an alias…" and before `## Host Data Layout`, insert:

```markdown
Run `avm ssh-config install` (or accept the prompt on your first
`avm create`) to wire an `Include ~/.avm/ssh_config` line into your
`~/.ssh/config`. After that, `ssh avm-<id>` works from any terminal
without flags. Requires OpenSSH 7.3+ (2016), which any modern macOS
or Linux ships.
```

- [ ] **Step 3: Update the Host Data Layout tree**

In the `~/.avm/` tree under `## Host Data Layout` (around line 210), add two entries alongside the existing ones (preserving the visual alignment of the existing tree):

```
├── ssh_config            # managed by `avm ssh-config`; included from ~/.ssh/config when installed
├── state.json            # avm CLI preferences (e.g. remembered install-prompt decision)
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document avm ssh-config in README"
```

---

## Task 10: Update host-side skill

**Files:**
- Modify: `skills/avm/SKILL.md`

- [ ] **Step 1: Describe the command and shortcut**

Find the section (or table) that enumerates commands. Add a line for `ssh-config`:

```markdown
- `avm ssh-config [sync|install|uninstall]` — generate and (optionally)
  hook `~/.avm/ssh_config` into `~/.ssh/config` so `ssh avm-<id>` works.
```

If the skill has a "Configuration" or "SSH" subsection, add a short note:

```markdown
After `avm ssh-config install` (or opting in during `avm create`), the
host's `~/.ssh/config` includes `~/.avm/ssh_config`, enabling
`ssh avm-<id>` directly from any terminal.
```

- [ ] **Step 2: Commit**

```bash
git add skills/avm/SKILL.md
git commit -m "Document avm ssh-config in host-side skill"
```

---

## Task 11: Final end-to-end verification

- [ ] **Step 1: Clean slate**

```bash
rm -f ~/.avm/state.json ~/.avm/ssh_config
node ./bin/avm.mjs ssh-config uninstall || true
```

- [ ] **Step 2: Full cycle**

```bash
node ./bin/avm.mjs create e2e-one
# Choose "Yes, install it" at the prompt.

# Verify Include installed
grep "avm managed" ~/.ssh/config

# Verify file contents
cat ~/.avm/ssh_config

# Verify end-user UX
ssh avm-e2e-one 'echo from inside; whoami; pwd'
# Expected: "from inside", "agent", "/home/agent"

# Create a second container; prompt should NOT appear
node ./bin/avm.mjs create e2e-two

# Both hosts should resolve
ssh avm-e2e-two 'echo two'

# Cleanup removes both entries
node ./bin/avm.mjs clean e2e-one e2e-two
grep -c "Host avm-e2e" ~/.avm/ssh_config || true
# Expected: 0

# Uninstall removes the Include
node ./bin/avm.mjs ssh-config uninstall
grep -c "avm managed" ~/.ssh/config || true
# Expected: 0
```

- [ ] **Step 3: Confirm build is clean**

```bash
pnpm run build
```
Expected: build succeeds.

- [ ] **Step 4: Confirm git status is clean**

```bash
git status
```
Expected: working tree clean.

---

## Out of Scope (reminder)

- Auto-installing without consent.
- Watching for container changes.
- Syncing on `start` / `stop` (ports are stable).
- Managing known_hosts.
- Modifying `avm ssh` itself — it continues to work standalone.
