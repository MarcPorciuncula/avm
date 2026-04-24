# Bridge `link` and `clone` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the per-repo symlink mechanism (`avm-link`) and the mirror-based clone dance out of the agent's hands and into the bridge, so config.yaml edits no longer require regeneration/rebuild and the in-container skill collapses to "run `avm-bridge clone <name>`".

**Architecture:** The bridge gains two new top-level subcommands, `link` and `clone`. Both run inside the container and call the daemon for any host-side data. `link` asks the daemon for the symlink list configured for a given repo and applies them to the cwd. `clone` reads the mirror's origin URL directly from the bind-mounted `~/mirrors/<name>.git`, runs `git clone --reference`, then invokes `link` automatically. The host-side `generateAvmLinkScript` and the `docker cp` of `/usr/local/bin/avm-link` go away entirely.

**Tech Stack:** TypeScript, citty (CLI), ConnectRPC + protobuf-es (bridge↔daemon), zx (`$` for shelling out to git). pnpm workspace.

**Test policy:** This project explicitly forbids automated tests (see CLAUDE.md "No automated tests"). Verification is by manual end-to-end at the points called out in tasks below. Do not add unit or integration tests.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `proto/avm/bridge/v1/repos.proto` | create | `ReposService.GetRepo(name) -> Repo { repeated SymlinkMount symlinks }` |
| `packages/shared/src/gen/avm/bridge/v1/repos_pb.ts` | regenerate | Generated protobuf-es stubs |
| `packages/shared/src/bridge-client.ts` | modify | Export `createBridgeReposClient` + types |
| `packages/avm-daemon/src/main.ts` | modify | Add `loadRepos()` (partial config parse like `loadConfig`); wire into `createRoutes` |
| `packages/avm-daemon/src/server.ts` | modify | Implement `ReposService.GetRepo` handler (returns symlinks for a name; empty list if unknown) |
| `packages/avm-bridge/src/cli/commands/link.ts` | create | `avm-bridge link [repo]` — fetch symlinks via daemon, apply to cwd |
| `packages/avm-bridge/src/cli/commands/clone.ts` | create | `avm-bridge clone <name>` — resolve mirror URL, `git clone --reference`, then `link` |
| `packages/avm-bridge/src/cli/avm-bridge.ts` | modify | Register `link` and `clone` subcommands |
| `packages/avm/src/lib/config-file.ts` | modify | Delete `generateAvmLinkScript` and the bash-escape guard logic in `splitShortForm` (kept only for shell safety; symlinks now go through `ln -sf` argv, no shell quoting) |
| `packages/avm/src/lib/session.ts` | modify | Drop avm-link generation/cp from `applyPostCreationSetup`; drop the `generateAvmLinkScript` import |
| `packages/avm/src/cli/commands/start.ts` | modify | Drop the obsolete "regenerate avm-link" comment |
| `templates/skills/avm-repos/SKILL.md` | rewrite | Collapse to "use `avm-bridge clone <name>`" plus the manual escape hatch |
| `skills/avm/SKILL.md` | modify | Update typical flow (clone with `avm-bridge clone`); update "Inside the Container" tools list (`avm-link` → `avm-bridge link`) |
| `README.md` | modify | Replace `avm-link` references with `avm-bridge link`; remove the "Generate `/usr/local/bin/avm-link`" step from the create flow narration |

**Out of scope (do NOT do):**

- Any `--branch`, `--into <dir>`, `--depth`, submodules, or multi-remote support on `clone`. Happy path only.
- Backwards compatibility shim for `/usr/local/bin/avm-link` (per project rules: no deprecation in internal code, delete and update consumers).
- Removing the bash-safety regex in `splitShortForm` is *optional*; if uncertain, leave it in place — it's harmless and may protect against shell injection in future code paths. **Default: leave it.**

---

## Task 1: Add the `ReposService` proto

**Files:**
- Create: `proto/avm/bridge/v1/repos.proto`

- [ ] **Step 1: Write the proto**

```proto
syntax = "proto3";
package avm.bridge.v1;

service ReposService {
  // GetRepo returns the configured per-repo overlay for a repo name.
  // Unknown repos return an empty Repo (not an error) — `link` is a
  // no-op for repos not declared in config.yaml.
  rpc GetRepo(GetRepoRequest) returns (Repo);
}

message GetRepoRequest {
  string name = 1;
}

message Repo {
  string name = 1;
  repeated SymlinkMount symlinks = 2;
}

message SymlinkMount {
  // Source path relative to ~/.avm-files/ (in container) /
  // ~/.avm/files/ (on host).
  string source = 1;
  // Target path relative to the working directory `link` is invoked from.
  string target = 2;
}
```

- [ ] **Step 2: Regenerate proto stubs**

Run: `pnpm buf:generate`
Expected: `packages/shared/src/gen/avm/bridge/v1/repos_pb.ts` is created. No errors. `git status` shows the new file.

- [ ] **Step 3: Commit**

```bash
git add proto/avm/bridge/v1/repos.proto packages/shared/src/gen/avm/bridge/v1/repos_pb.ts
git commit -m "Add ReposService proto for bridge-side link"
```

---

## Task 2: Export the repos client from `@avm/shared`

**Files:**
- Modify: `packages/shared/src/bridge-client.ts`

- [ ] **Step 1: Add import + export + factory**

Open `packages/shared/src/bridge-client.ts`. After the existing `NotificationService` import block (line 6), add:

```ts
import { ReposService } from "./gen/avm/bridge/v1/repos_pb.js";
```

After the `NotificationService` re-export block (line 31-36), add:

```ts
export { ReposService } from "./gen/avm/bridge/v1/repos_pb.js";
export type {
  GetRepoRequest,
  Repo,
  SymlinkMount,
} from "./gen/avm/bridge/v1/repos_pb.js";
```

After the existing `createBridgeNotificationClient` factory at the end of the file, add:

```ts
export function createBridgeReposClient(port: number, token: string) {
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
    interceptors: [authInterceptor(token)],
  });
  return createClient(ReposService, transport);
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm build`
Expected: Build succeeds. No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/bridge-client.ts
git commit -m "Export createBridgeReposClient from @avm/shared"
```

---

## Task 3: Daemon-side `loadRepos` partial parser

**Files:**
- Modify: `packages/avm-daemon/src/main.ts`

This mirrors the existing `loadConfig()` (services) pattern — a defensive shallow YAML parse so the daemon doesn't depend on `@avm/cli`.

- [ ] **Step 1: Add the SymlinkSpec type and loader**

In `packages/avm-daemon/src/main.ts`, just below the existing `loadConfig` function (ends around line 53), add:

```ts
export type SymlinkSpec = { source: string; target: string };
export type RepoSpec = { symlinks: SymlinkSpec[] };

/** Lightweight parse of ~/.avm/config.yaml to extract per-repo symlink config. */
function loadRepos(): Record<string, RepoSpec> {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const doc = parseDocument(raw);
    const parsed = doc.toJS() as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return {};

    const repos = parsed.repos as Record<string, unknown> | undefined;
    if (!repos || typeof repos !== "object") return {};

    const result: Record<string, RepoSpec> = {};
    for (const [name, value] of Object.entries(repos)) {
      if (!value || typeof value !== "object") continue;
      const repo = value as Record<string, unknown>;
      const rawSymlinks = repo.symlinks;
      if (!Array.isArray(rawSymlinks)) {
        result[name] = { symlinks: [] };
        continue;
      }
      const symlinks: SymlinkSpec[] = [];
      for (const entry of rawSymlinks) {
        if (typeof entry !== "string") continue;
        const idx = entry.indexOf(":");
        if (idx <= 0 || idx === entry.length - 1) continue;
        symlinks.push({
          source: entry.slice(0, idx),
          target: entry.slice(idx + 1),
        });
      }
      result[name] = { symlinks };
    }
    return result;
  } catch {
    return {};
  }
}
```

- [ ] **Step 2: Pass `loadRepos` into `createRoutes`**

Find the `createRoutes(registry, stateStore, loadConfig)` call in `main()` (around line 91) and change it to:

```ts
const connectHandler = connectNodeAdapter({ routes: createRoutes(registry, stateStore, loadConfig, loadRepos) });
```

(The signature of `createRoutes` will be updated in Task 4.)

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: Compile error in `server.ts` because `createRoutes` doesn't accept a 4th argument yet. That's expected — Task 4 fixes it. Don't commit yet.

- [ ] **Step 4: Continue to Task 4 before committing**

(We commit Tasks 3 and 4 together because the build is broken between them.)

---

## Task 4: Daemon-side `ReposService` handler

**Files:**
- Modify: `packages/avm-daemon/src/server.ts`

- [ ] **Step 1: Add the proto imports**

At the top of `packages/avm-daemon/src/server.ts`, after the `NotificationService` import block (around line 36), add:

```ts
import {
  ReposService,
  RepoSchema,
  SymlinkMountSchema,
} from "@avm/shared/gen/avm/bridge/v1/repos_pb";
```

- [ ] **Step 2: Update the `createRoutes` signature and add the handler**

Change the `createRoutes` signature from:

```ts
export function createRoutes(
  registry: ServiceRegistry,
  stateStore: StateStore,
  loadConfig: () => Record<string, ServiceConfig>,
): (router: ConnectRouter) => void {
```

to:

```ts
export function createRoutes(
  registry: ServiceRegistry,
  stateStore: StateStore,
  loadConfig: () => Record<string, ServiceConfig>,
  loadRepos: () => Record<string, { symlinks: { source: string; target: string }[] }>,
): (router: ConnectRouter) => void {
```

Then, immediately before the `// Container management API` block near the bottom of `createRoutes`, add:

```ts
    // Bridge repos API (called by containers)
    router.service(ReposService, {
      async getRepo(req) {
        const repos = loadRepos();
        const repo = repos[req.name];
        const symlinks = (repo?.symlinks ?? []).map((s) =>
          create(SymlinkMountSchema, { source: s.source, target: s.target }),
        );
        return create(RepoSchema, {
          name: req.name,
          symlinks,
        });
      },
    });
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: Build succeeds. No TypeScript errors.

- [ ] **Step 4: Smoke test the daemon endpoint**

Restart the daemon so it picks up the new code:

```bash
avm daemon stop || true
avm daemon start
```

(There's no host-side CLI for `GetRepo` and there shouldn't be — the bridge is the only client. We'll verify it works end-to-end in Task 7.)

- [ ] **Step 5: Commit Tasks 3 + 4 together**

```bash
git add packages/avm-daemon/src/main.ts packages/avm-daemon/src/server.ts
git commit -m "Add ReposService handler to daemon for per-repo symlink lookups"
```

---

## Task 5: `avm-bridge link` command

**Files:**
- Create: `packages/avm-bridge/src/cli/commands/link.ts`

`link` resolves the repo name (positional arg, defaults to `basename(cwd)`), fetches the configured symlinks, and applies them with `ln -sf`. The source side is rooted at `$HOME/.avm-files/` (the bind-mounted host `~/.avm/files/`). Targets are relative to cwd. Idempotent. Repos not in config → no-op.

- [ ] **Step 1: Write the command**

Create `packages/avm-bridge/src/cli/commands/link.ts`:

```ts
import { defineCommand } from "citty";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { createBridgeReposClient } from "@avm/shared/bridge-client";
import { ConnectError } from "@connectrpc/connect";

function getClient() {
  const port = process.env.AVM_HOST_PORT;
  const token = process.env.AVM_HOST_TOKEN;

  if (!port) {
    console.error("AVM_HOST_PORT is not set. This command must run inside an avm container.");
    process.exit(1);
  }
  if (!token) {
    console.error("AVM_HOST_TOKEN is not set. This command must run inside an avm container.");
    process.exit(1);
  }

  return createBridgeReposClient(Number(port), token);
}

export const linkCommand = defineCommand({
  meta: {
    name: "link",
    description:
      "Apply per-repo symlinks declared in ~/.avm/config.yaml to the current working copy.",
  },
  args: {
    repo: {
      type: "positional",
      description: "Repo name (defaults to basename of cwd).",
      required: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd();
    const repoName = args.repo ?? basename(cwd);

    const client = getClient();
    let repo;
    try {
      repo = await client.getRepo({ name: repoName });
    } catch (err) {
      if (err instanceof ConnectError) {
        console.error(err.message);
      } else {
        console.error(`Error: ${err}`);
      }
      process.exit(1);
    }

    if (repo.symlinks.length === 0) {
      // Match prior `avm-link` behaviour: silent no-op for unconfigured repos.
      return;
    }

    const filesRoot = join(homedir(), ".avm-files");
    for (const link of repo.symlinks) {
      const src = join(filesRoot, link.source);
      const target = isAbsolute(link.target) ? link.target : resolve(cwd, link.target);
      const parent = dirname(target);
      if (parent !== "." && parent !== "/") {
        mkdirSync(parent, { recursive: true });
      }
      // ln -sf semantics: replace existing symlink/file at target.
      try {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink() || stat.isFile()) {
          unlinkSync(target);
        }
      } catch {
        // Target doesn't exist — fine.
      }
      symlinkSync(src, target);
      console.log(`linked ${link.target} -> ${src}`);
    }
  },
});
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Build succeeds. `dist/avm-bridge.mjs` is rebuilt.

- [ ] **Step 3: Commit**

```bash
git add packages/avm-bridge/src/cli/commands/link.ts
git commit -m "Add avm-bridge link command"
```

---

## Task 6: `avm-bridge clone` command

**Files:**
- Create: `packages/avm-bridge/src/cli/commands/clone.ts`

`clone <name>` looks up `~/mirrors/<name>.git`, reads its `origin` URL, then runs `git clone --reference ~/mirrors/<name>.git <url> ~/work/<name>`. After a successful clone, runs `link` against the new directory. `--url` lets the caller supply a URL when no mirror exists. `--no-link` skips the post-clone link.

- [ ] **Step 1: Write the command**

Create `packages/avm-bridge/src/cli/commands/clone.ts`:

```ts
import { defineCommand } from "citty";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createBridgeReposClient } from "@avm/shared/bridge-client";
import { ConnectError } from "@connectrpc/connect";

function getReposClient() {
  const port = process.env.AVM_HOST_PORT;
  const token = process.env.AVM_HOST_TOKEN;
  if (!port || !token) {
    console.error("AVM_HOST_PORT/AVM_HOST_TOKEN unset. This command must run inside an avm container.");
    process.exit(1);
  }
  return createBridgeReposClient(Number(port), token);
}

function readMirrorOriginUrl(mirrorPath: string): string {
  // `git -C <bare> remote get-url origin` works on bare mirrors.
  const out = execFileSync("git", ["-C", mirrorPath, "remote", "get-url", "origin"], {
    encoding: "utf-8",
  });
  return out.trim();
}

export const cloneCommand = defineCommand({
  meta: {
    name: "clone",
    description:
      "Clone a repo into ~/work/<name>, using the host mirror at ~/mirrors/<name>.git when present.",
  },
  args: {
    name: {
      type: "positional",
      description: "Repo name. Used for the mirror lookup and the working-copy directory.",
      required: true,
    },
    url: {
      type: "string",
      description: "Override remote URL. Required if no mirror exists for <name>.",
    },
    "no-link": {
      type: "boolean",
      description: "Skip the post-clone `avm-bridge link` step.",
    },
  },
  async run({ args }) {
    const home = homedir();
    const mirrorPath = join(home, "mirrors", `${args.name}.git`);
    const targetDir = join(home, "work", args.name);

    if (existsSync(targetDir)) {
      console.error(
        `Error: ${targetDir} already exists. cd into it and run \`avm-bridge link\` instead.`,
      );
      process.exit(1);
    }

    const hasMirror = existsSync(mirrorPath);
    let url = args.url;
    if (!url) {
      if (!hasMirror) {
        console.error(
          `Error: no mirror at ${mirrorPath} and no --url provided. ` +
            `Pass --url <git-url> or ask the user to add a mirror at ~/.avm/mirrors/${args.name}.git on the host.`,
        );
        process.exit(1);
      }
      try {
        url = readMirrorOriginUrl(mirrorPath);
      } catch (err) {
        console.error(`Error: failed to read origin URL from ${mirrorPath}: ${err}`);
        process.exit(1);
      }
    }

    const gitArgs = ["clone"];
    if (hasMirror) {
      gitArgs.push("--reference", mirrorPath);
    }
    gitArgs.push(url, targetDir);

    console.log(`==> git ${gitArgs.join(" ")}`);
    const cloneRes = spawnSync("git", gitArgs, { stdio: "inherit" });
    if (cloneRes.status !== 0) {
      process.exit(cloneRes.status ?? 1);
    }

    if (args["no-link"]) {
      return;
    }

    // Reuse the daemon lookup for the link step. Inline it here rather than
    // shelling back to `avm-bridge link` to keep one process and one daemon
    // round trip.
    const client = getReposClient();
    let repo;
    try {
      repo = await client.getRepo({ name: args.name });
    } catch (err) {
      if (err instanceof ConnectError) {
        console.error(`Warning: link skipped — ${err.message}`);
      } else {
        console.error(`Warning: link skipped — ${err}`);
      }
      return;
    }
    if (repo.symlinks.length === 0) {
      return;
    }

    // Apply links exactly as `link` does, but anchored at targetDir.
    const { mkdirSync, symlinkSync, unlinkSync, lstatSync } = await import("node:fs");
    const { dirname, isAbsolute, resolve: pathResolve } = await import("node:path");
    const filesRoot = join(home, ".avm-files");
    for (const link of repo.symlinks) {
      const src = join(filesRoot, link.source);
      const target = isAbsolute(link.target) ? link.target : pathResolve(targetDir, link.target);
      const parent = dirname(target);
      if (parent !== "." && parent !== "/") mkdirSync(parent, { recursive: true });
      try {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink() || stat.isFile()) unlinkSync(target);
      } catch {
        // Target doesn't exist — fine.
      }
      symlinkSync(src, target);
      console.log(`linked ${link.target} -> ${src}`);
    }
  },
});
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/avm-bridge/src/cli/commands/clone.ts
git commit -m "Add avm-bridge clone command (mirror-aware, auto-link)"
```

---

## Task 7: Wire `link` and `clone` into the bridge CLI

**Files:**
- Modify: `packages/avm-bridge/src/cli/avm-bridge.ts`

- [ ] **Step 1: Register the commands**

Replace the contents of `packages/avm-bridge/src/cli/avm-bridge.ts` with:

```ts
import { defineCommand, runMain } from "citty";
import { browserCommand } from "./commands/browser.ts";
import { editorCommand } from "./commands/editor.ts";
import { serviceCommand } from "./commands/service.ts";
import { claudeHookCommand } from "./commands/claude-hook.ts";
import { linkCommand } from "./commands/link.ts";
import { cloneCommand } from "./commands/clone.ts";

const main = defineCommand({
  meta: {
    name: "avm-bridge",
    description: "avm bridge: coordinate with the host control plane.",
  },
  subCommands: {
    browser: browserCommand,
    editor: editorCommand,
    service: serviceCommand,
    "claude-hook": claudeHookCommand,
    link: linkCommand,
    clone: cloneCommand,
  },
});

runMain(main);
```

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: Build succeeds. `dist/avm-bridge.mjs` includes the new commands.

- [ ] **Step 3: First end-to-end smoke test**

This is the critical checkpoint — verify the bridge can talk to the daemon for repo data before we delete the old `avm-link` mechanism.

```bash
# Restart daemon to pick up Task 3+4 changes if you haven't already.
avm daemon stop || true
avm daemon start

# Use an existing avm container (or create one). Get its short ID from `avm list`.
# Replace <id> with that short ID below.
avm exec <id> avm-bridge link --help
```

Expected: Help text for `avm-bridge link` is printed.

```bash
# Pick a repo name that exists in your ~/.avm/config.yaml under `repos:`.
# If there's none, add one temporarily:
#   repos:
#     scratch:
#       symlinks:
#         - test:test-link
# and `mkdir -p ~/.avm/files && touch ~/.avm/files/test`.
#
# Then inside the container:
avm exec <id> bash -lc "mkdir -p ~/work/scratch && cd ~/work/scratch && avm-bridge link scratch && ls -la"
```

Expected: Output shows `linked test -> /home/agent/.avm-files/test`, and `ls -la` shows `test-link -> /home/agent/.avm-files/test`.

If this fails: stop, debug, and fix before continuing. The remaining tasks delete the old mechanism, so you must have the new one working first.

- [ ] **Step 4: Commit**

```bash
git add packages/avm-bridge/src/cli/avm-bridge.ts
git commit -m "Register avm-bridge link and clone subcommands"
```

---

## Task 8: Remove the old `avm-link` script-generation path

**Files:**
- Modify: `packages/avm/src/lib/session.ts`
- Modify: `packages/avm/src/lib/config-file.ts`
- Modify: `packages/avm/src/cli/commands/start.ts`

- [ ] **Step 1: Remove avm-link cp from `applyPostCreationSetup`**

In `packages/avm/src/lib/session.ts`:

Change the import on line 30 from:

```ts
import { type AvmConfig, loadAvmConfig, generateAvmLinkScript } from "./config-file.ts";
```

to:

```ts
import { type AvmConfig, loadAvmConfig } from "./config-file.ts";
```

Remove the `unlinkSync` and `writeFileSync` from the `node:fs` imports if they have no other use. (Check first — `writeFileSync` is used in `ensureHostScaffolding` for the empty claude.json, so keep it. `unlinkSync` is only used in the avm-link block, so remove it.)

Delete the entire `// --- Generate and install avm-link ---` block (lines 169-178), which is:

```ts
  // --- Generate and install avm-link ---
  const script = generateAvmLinkScript(config);
  const tempFile = "avm-link-tmp.sh";
  writeFileSync(tempFile, script);
  try {
    await $`docker cp ${tempFile} ${containerName}:/usr/local/bin/avm-link`;
    await $`docker exec -u root ${containerName} chmod +x /usr/local/bin/avm-link`;
  } finally {
    unlinkSync(tempFile);
  }
```

Update the docstring on `applyPostCreationSetup` (lines 138-144). Currently:

```ts
/**
 * Post-creation setup that copies files into a container via `docker cp`
 * and `docker exec`. Called after `docker run` or `docker start`.
 *
 * 1. Symlinks image-shipped skills into ~/.claude/skills/.
 * 2. Generates and installs the avm-link script.
 */
```

Change to:

```ts
/**
 * Post-creation setup run after `docker run` or `docker start`.
 * Persists AVM_* env vars for SSH, symlinks image-shipped skills into
 * ~/.claude/skills/, and ensures avm-bridge is executable.
 */
```

The `config: AvmConfig` parameter is now unused. Drop it from the signature and from both call sites in `cli/commands/create.ts` and `cli/commands/start.ts`.

- [ ] **Step 2: Update `start.ts` comment**

In `packages/avm/src/cli/commands/start.ts` lines 86-88, the block:

```ts
    // Regenerate /usr/local/bin/avm-link so config.yaml changes
    // take effect on resume.
    await applyPostCreationSetup(vmName, config);
```

becomes:

```ts
    await applyPostCreationSetup(vmName);
```

(The comment is now misleading and the call signature changed.)

- [ ] **Step 3: Update `create.ts` call site**

In `packages/avm/src/cli/commands/create.ts` line 109, change `await applyPostCreationSetup(vmName, config);` to `await applyPostCreationSetup(vmName);`.

- [ ] **Step 4: Delete `generateAvmLinkScript`**

In `packages/avm/src/lib/config-file.ts`, delete the entire `generateAvmLinkScript` function (lines 135-170, including its docstring) and the `path` import on line 2 if it has no other use. (Check first — only `generateAvmLinkScript` uses `path`, so remove `path` from the import.)

The import line 2 currently:

```ts
import { path } from "zx";
```

Remove it entirely.

The `splitShortForm` shell-safety regex (lines 306-313) **stays** — it's defensive and may protect against future code paths that interpolate these values into shells.

- [ ] **Step 5: Build and verify**

Run: `pnpm build`
Expected: Build succeeds with no warnings about unused imports.

- [ ] **Step 6: Sanity check — no leftover references**

Run: `rg "generateAvmLinkScript|/usr/local/bin/avm-link" packages/`
Expected: No matches.

Run: `rg "avm-link" packages/`
Expected: No matches in source files. (Doc/template references are handled in later tasks.)

- [ ] **Step 7: Commit**

```bash
git add packages/avm/src/lib/session.ts packages/avm/src/lib/config-file.ts packages/avm/src/cli/commands/start.ts packages/avm/src/cli/commands/create.ts
git commit -m "Remove avm-link script generation; bridge owns linking now"
```

---

## Task 9: Rewrite `templates/skills/avm-repos/SKILL.md`

**Files:**
- Modify: `templates/skills/avm-repos/SKILL.md`

This is the in-container skill the avm agent reads when asked to clone a repo. With `avm-bridge clone` doing the work, it should collapse dramatically.

- [ ] **Step 1: Replace contents**

Replace the entire file with:

```markdown
---
name: avm-repos
description: Use when the agent needs to clone a repo or set up a workspace. Must be consulted before cloning any repo.
---

# Setting up repos in avm

Use `avm-bridge clone <name>` to set up a repo in `~/work/`. The bridge
resolves the host mirror at `~/mirrors/<name>.git` (if present), runs
`git clone --reference`, and applies any per-repo symlinks declared in
the user's avm config — all in one step.

## Usage

```
avm-bridge clone <name>
```

This clones into `~/work/<name>`. If `~/mirrors/<name>.git` exists, the
clone is reference-based (fast). After cloning, per-repo symlinks (env
files, config overrides, etc.) are applied automatically.

If there is no mirror for `<name>`, ask the user for the clone URL and
pass it explicitly:

```
avm-bridge clone <name> --url <git-url>
```

To skip the post-clone link step:

```
avm-bridge clone <name> --no-link
```

## Re-applying links in an existing working copy

If you already have a working copy and want to re-apply per-repo
symlinks (e.g. after the user edited their config), run from inside it:

```
cd ~/work/<name>
avm-bridge link
```

By default `link` uses the directory's basename as the repo name. Pass
the name explicitly if they differ: `avm-bridge link <name>`. Safe to
re-run; repos not declared in config are a no-op.

## Manual clones (rare)

For non-default targets — a different directory, a specific branch,
submodules, or a second remote — clone with `git` directly, then run
`avm-bridge link <name>` from inside the working copy.

## Scope: clone and setup only

After cloning, you may install workspace dependencies (e.g.
`pnpm install`, `bundle install`) but **stop there**. Do not start
services, dev servers, run database migrations, or take any action
that affects runtime state or makes assumptions about external
systems — unless the user explicitly asks.

"Set up the repo" means clone it, link it, and install dependencies —
not run it.
```

- [ ] **Step 2: Commit**

```bash
git add templates/skills/avm-repos/SKILL.md
git commit -m "Rewrite avm-repos skill around avm-bridge clone"
```

---

## Task 10: Update host-side docs

**Files:**
- Modify: `skills/avm/SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Update `skills/avm/SKILL.md` typical flow**

Find the section "User wants a working copy of a specific repo inside the container" (around line 117). Replace the code block:

```
avm create --attach
# (inside the container)
cd ~/work
git clone --reference ~/mirrors/<repo>.git \
  git@github.com:<owner>/<repo>.git \
  <repo>
cd <repo>
avm-link            # applies any symlinks declared in ~/.avm/config.yaml
```

with:

```
avm create --attach
# (inside the container)
avm-bridge clone <repo>
```

Then in the "Inside the Container" section (around line 170), replace these two list items:

```
- `avm-link` — applies the per-repo symlinks from `~/.avm/config.yaml`
- `avm-bridge` — CLI for coordinating with the host daemon (start/stop
  host services, open files in the user's editor). See the avm-services
  and avm-editor skills inside the container for usage.
```

with:

```
- `avm-bridge` — CLI for coordinating with the host daemon. Includes
  `avm-bridge clone <name>` and `avm-bridge link` for repo setup, plus
  service control and host editor/browser integration. See the
  avm-repos, avm-services, and avm-editor skills inside the container.
```

- [ ] **Step 2: Update `README.md`**

Find every reference to `avm-link` in `README.md` (use `rg -n "avm-link" README.md`) and update:

- Line 130: change `applied by \`avm-link\`` → `applied by \`avm-bridge link\``
- Line 211: change `\`avm-link\` applies the` → `\`avm-bridge link\` applies the`
- Line 247: change `# symlink sources for avm-link` → `# symlink sources for avm-bridge link`
- Line 264: delete the entire bullet "2. Generate `/usr/local/bin/avm-link` from `config.yaml`." and renumber subsequent bullets in that list.
- Line 274-275: change `mirrors at \`~/mirrors/\`, overlay files at \`~/.avm-files/\`, and \`avm-link\` on the PATH` → `mirrors at \`~/mirrors/\`, overlay files at \`~/.avm-files/\`, and \`avm-bridge\` on the PATH`

Find the "Mirrors" / clone-flow section near line 413 and update any reference to `git clone --reference ~/mirrors/...` examples to mention that agents typically use `avm-bridge clone <name>` instead, with the manual `git clone --reference` form as the manual-fallback example.

- [ ] **Step 3: Sanity check — no leftover `avm-link` references**

Run: `rg -n "avm-link" README.md skills/ templates/ packages/`
Expected: No matches.

- [ ] **Step 4: Commit**

```bash
git add skills/avm/SKILL.md README.md
git commit -m "Update host-side docs for avm-bridge clone/link"
```

---

## Task 11: Full end-to-end manual test

This is the verification gate before opening the PR. Per project rules, this is the only test that matters.

- [ ] **Step 1: Provision/build everything**

```bash
pnpm build
```

Expected: All four bundle targets build cleanly (`avm`, `avm-daemon`, `avm-bridge`).

- [ ] **Step 2: Restart daemon**

```bash
avm daemon stop || true
avm daemon start
avm daemon status
```

Expected: Daemon is reachable.

- [ ] **Step 3: Create a fresh container and link to a repo with mirror**

Pick a repo you have a mirror for (run `ls ~/.avm/mirrors/` to see). Below uses `<mirror-repo>` as a placeholder.

```bash
avm create test-bridge-link --attach
# Inside the container:
avm-bridge clone <mirror-repo>
ls ~/work/<mirror-repo>
git -C ~/work/<mirror-repo> remote -v
exit
```

Expected:
- The clone runs, prints `==> git clone --reference …`, and finishes successfully.
- `~/work/<mirror-repo>` exists and contains the repo contents.
- `git remote -v` shows the same URL the mirror has for `origin`.
- If `<mirror-repo>` is declared in `~/.avm/config.yaml` under `repos:`, you also see `linked …` lines.

- [ ] **Step 4: Re-run `link` standalone**

```bash
avm exec test-bridge-link bash -lc "cd ~/work/<mirror-repo> && avm-bridge link"
```

Expected: Either `linked …` lines (if configured) or silent (if not).

- [ ] **Step 5: Test the no-mirror path with `--url`**

Pick a tiny public repo without a mirror.

```bash
avm exec test-bridge-link bash -lc "avm-bridge clone tiny-test --url https://github.com/octocat/Hello-World.git"
ls ~/work/tiny-test  # should fail because we ran from the wrong shell
avm exec test-bridge-link bash -lc "ls ~/work/tiny-test"
```

Expected: clones successfully without `--reference`. `git remote -v` inside the container shows the provided URL.

- [ ] **Step 6: Test the duplicate-target guard**

```bash
avm exec test-bridge-link avm-bridge clone <mirror-repo>
```

Expected: Errors with "already exists. cd into it and run `avm-bridge link` instead." and exits non-zero.

- [ ] **Step 7: Test that config edits take effect without rebuild**

On the host, edit `~/.avm/config.yaml` and add a new symlink under an existing repo entry. (E.g. `- newfile:newfile-link` and `touch ~/.avm/files/newfile`.) Save.

```bash
avm exec test-bridge-link bash -lc "cd ~/work/<mirror-repo> && avm-bridge link && ls -la newfile-link"
```

Expected: The new symlink appears immediately. **No `avm start`, no rebuild, no docker cp.** This is the headline win.

- [ ] **Step 8: Test that `avm start` of an existing container still works**

```bash
exit  # if attached
avm stop test-bridge-link
avm start test-bridge-link
# Verify everything still works
avm exec test-bridge-link bash -lc "ls /usr/local/bin/avm-bridge && avm-bridge --help"
```

Expected: Container restarts cleanly. `avm-bridge` is present and executable. No reference to `/usr/local/bin/avm-link` anywhere in start output.

- [ ] **Step 9: Cleanup**

```bash
avm clean test-bridge-link
```

- [ ] **Step 10: If anything failed**

Stop, fix the failing piece, rebuild, and rerun the affected steps. Do not move on to the PR until every step above passes.

---

## Task 12: Open the PR

- [ ] **Step 1: Final sanity check**

```bash
git status
git log main..HEAD --oneline
```

Expected: Clean working tree. ~6-8 logical commits, each scoped.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin bridge-link-clone
gh pr create --title "Move avm-link into bridge; add avm-bridge clone" --body "$(cat <<'EOF'
## Summary

- `avm-link` was a generated bash script `docker cp`'d into every container at `avm create`/`avm start` time. Per-repo symlink config edits required no rebuild, but they still required a host-side regeneration round trip. The mechanism predates the bridge.
- This PR moves the symlink mechanism into `avm-bridge link` (calls a new `ReposService` on the daemon to fetch the per-repo symlink list, then applies them in-container). Config edits now take effect immediately, with no host-side step.
- Adds `avm-bridge clone <name>` which resolves the host mirror at `~/mirrors/<name>.git` (via the bind mount), runs `git clone --reference`, and runs `link` automatically. The in-container `avm-repos` skill collapses to roughly one command.
- The old `/usr/local/bin/avm-link` script and its host-side generator are deleted (no deprecation per the project's internal-codebase policy).

## Test plan

- [x] Manual end-to-end (Task 11 in the plan): clone with mirror, clone with `--url`, re-run link standalone, edit config and verify no rebuild needed, restart container.
EOF
)"
```

Expected: PR is created. Capture and report the URL.

---

## Self-Review Notes

- **Spec coverage:** Both proposals from the user are addressed — `avm-link` becomes `avm-bridge link` (Tasks 1-5, 7, 8); mirror-aware clone becomes `avm-bridge clone` (Task 6). Skill collapses (Task 9). Host docs updated (Task 10).
- **Type consistency:** `SymlinkMount` proto message → `Repo.symlinks` field → `link.source`/`link.target` in TS — consistent throughout.
- **Method names:** `getRepo` (RPC), `createBridgeReposClient` (factory), `loadRepos` (daemon parser) — consistent.
- **Files referenced** (`session.ts`, `start.ts`, `create.ts`, `config-file.ts`) all confirmed during context-gathering.
- **No tests added** — matches project rule. Manual e2e is the verification step.
- **Scope discipline:** No `--branch`, `--depth`, `--into`, submodule, or back-compat work. Happy path only, escape hatch documented in the skill.
