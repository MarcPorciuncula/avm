# Decouple avm from a specific agent harness — Implementation Plan

Spec: docs/superpowers/specs/2026-05-12-agent-harness-decoupling-design.md

**Goal:** Pull Claude-specific behaviour out of avm's core image and fixed
mounts; re-deliver it via three new config fields (`agents_md`,
`skills_dir`, `integrations`), the existing `volumes:` primitive, and a
Claude-defaults bundle in `examples/`. Existing users migrate
transparently via an idempotent layout move on first run.

**Reference reading before starting:**
- `docs/superpowers/specs/2026-05-12-agent-harness-decoupling-design.md` — full design
- `packages/avm/src/lib/config.ts` — path constants for `~/.avm/` layout
- `packages/avm/src/lib/config-file.ts` — `AvmConfig`, parser, validators
- `packages/avm/src/lib/session.ts` — `ensureHostScaffolding`, `getDockerMountArgs`, `applyPostCreationSetup`, `generateRootClaudeMd`
- `packages/avm/src/lib/desktop-config.ts` — `installDesktopConfig`, `uninstallDesktopConfig`, `syncHostIntegrations` (in `ssh-config.ts`)
- `packages/avm/src/lib/notify-hooks.ts` — install/uninstall hook entries (unchanged in this work)
- `packages/avm/src/lib/state.ts` — `AvmState` shape
- `packages/avm/src/cli/commands/create.ts` — first-run prompts
- `packages/avm/src/cli/commands/provision.ts` — `maybePromptForInstall` call
- `packages/avm/src/cli/commands/ssh-config.ts` — install/uninstall with `--desktop` flags
- `packages/avm/src/cli/commands/notify.ts` — install/uninstall command
- `dockerfiles/core.Dockerfile` — Claude install, alias, COPY directives
- `templates/vm-claude.md` — the file being renamed and rewritten
- `examples/Dockerfile`, `examples/config.yaml` — the bundle being rewritten
- `README.md` — sections under "First-Time Setup", "Host Data Layout", "Customizing"
- `skills/avm/SKILL.md` — the host-side skill

**Build commands:**
- `pnpm build` — bundle the CLI + bridge to `dist/`
- `pnpm exec tsc --noEmit` (from `packages/avm`) — type-check only
- No automated tests (per project convention)

---

## Task 1: Add agents_md, skills_dir, integrations to config schema
- [ ] Status

### Scope

Add the three new config fields and their parsing logic. Pure
type/parser additions — no behaviour change yet. Subsequent tasks read
these fields to drive new behaviour.

### Approach

Edit `packages/avm/src/lib/config-file.ts`.

Extend `AvmConfig`:

```ts
export interface AvmConfig {
  editor?: EditorChoice;
  daemon: DaemonConfig;
  prune_images: PruneImagesConfig;
  agents_md: string[];
  skills_dir: string[];
  volumes: VolumeMount[];
  repos: Record<string, RepoConfig>;
  services: Record<string, ServiceDefinition>;
  integrations: IntegrationsConfig;
  notifications: NotificationsConfig;
}

export interface IntegrationsConfig {
  claude_notifications: boolean;
  claude_desktop: boolean;
}
```

Add to `TOP_LEVEL_KEYS`: `"agents_md"`, `"skills_dir"`, `"integrations"`.

Add three parse helpers modelled on `parseEditor`/`parseDaemon`:

```ts
function parseStringOrList(raw: unknown, fieldName: string): string[] {
  if (raw === undefined) return [];
  const entries = Array.isArray(raw) ? raw : [raw];
  return entries.map((entry, i) => {
    const ctx = entries.length > 1 ? `${fieldName}[${i}]` : fieldName;
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        `${avmConfigFile}: ${ctx} must be a non-empty string (got ${describe(entry)}).`,
      );
    }
    // Reject shell-unsafe chars (same rule as splitShortForm).
    const unsafeChars = /["$`\\]|[\x00-\x1f\x7f]/;
    if (unsafeChars.test(entry)) {
      throw new Error(
        `${avmConfigFile}: ${ctx} ("${entry}") contains unsafe characters.`,
      );
    }
    return entry;
  });
}

function parseAgentsMd(raw: unknown): string[] {
  if (raw === undefined) return ["~/AGENTS.md"];
  return parseStringOrList(raw, "agents_md");
}

function parseSkillsDir(raw: unknown): string[] {
  return parseStringOrList(raw, "skills_dir");
}

const INTEGRATIONS_KEYS = new Set(["claude_notifications", "claude_desktop"]);

function parseIntegrations(raw: unknown): IntegrationsConfig {
  const result: IntegrationsConfig = {
    claude_notifications: false,
    claude_desktop: false,
  };
  if (raw === undefined) return result;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "integrations" must be a mapping (got ${describe(raw)}).`,
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!INTEGRATIONS_KEYS.has(key)) {
      console.warn(
        `${avmConfigFile}: unknown key "${key}" under integrations (ignored). Allowed: ${[...INTEGRATIONS_KEYS].join(", ")}.`,
      );
    }
  }
  for (const key of INTEGRATIONS_KEYS) {
    if (obj[key] !== undefined) {
      if (typeof obj[key] !== "boolean") {
        throw new Error(
          `${avmConfigFile}: integrations.${key} must be a boolean (got ${describe(obj[key])}).`,
        );
      }
      result[key as keyof IntegrationsConfig] = obj[key] as boolean;
    }
  }
  return result;
}
```

Wire them into `validate()`:

```ts
function validate(data: unknown): AvmConfig {
  // ... existing top-level checks ...
  const agents_md = parseAgentsMd(obj.agents_md);
  const skills_dir = parseSkillsDir(obj.skills_dir);
  const integrations = parseIntegrations(obj.integrations);
  // ... existing parses ...
  return { editor, daemon, prune_images, agents_md, skills_dir, volumes, repos, services, integrations, notifications };
}
```

Update `loadAvmConfig`'s empty-config fallback to include the new defaults:

```ts
return {
  daemon: { port: 6970 },
  prune_images: defaultPruneImagesConfig(),
  agents_md: ["~/AGENTS.md"],
  skills_dir: [],
  volumes: [],
  repos: {},
  services: {},
  integrations: { claude_notifications: false, claude_desktop: false },
  notifications: structuredClone(DEFAULT_NOTIFICATIONS),
};
```

Add `setConfigIntegration` helper near the existing `setConfigEditor`:

```ts
export function setConfigIntegration(
  key: "claude_notifications" | "claude_desktop",
  value: boolean,
): void {
  const raw = existsSync(avmConfigFile)
    ? readFileSync(avmConfigFile, "utf-8")
    : "";
  const doc = parseDocument(raw);
  doc.setIn(["integrations", key], value);
  writeFileSync(avmConfigFile, doc.toString());
}
```

### Files

- packages/avm/src/lib/config-file.ts (modify)

### Done criteria

- `pnpm build` succeeds with no type errors.
- `AvmConfig` exposes `agents_md: string[]`, `skills_dir: string[]`,
  `integrations: { claude_notifications: boolean; claude_desktop: boolean }`.
- `loadAvmConfig()` on a missing config returns the documented defaults.
- `loadAvmConfig()` on a config with `agents_md: ~/CLAUDE.md` (string)
  returns `["~/CLAUDE.md"]`.
- `loadAvmConfig()` on a config with `agents_md: [~/AGENTS.md, ~/CLAUDE.md]`
  returns both entries.
- Invalid types throw with a message identifying the offending field.
- `setConfigIntegration("claude_desktop", true)` writes
  `integrations.claude_desktop: true` to `~/.avm/config.yaml` preserving
  surrounding content.

---

## Task 2: Flatten ~/.avm/system/ and rename CLAUDE.md to AGENTS.md
- [ ] Status
Depends on: Task 1

### Scope

End-to-end rename: host layout flattens (`~/.avm/system/credentials/{ssh,git}`
moves to `~/.avm/volumes/{ssh,git}`; `~/.avm/system/CLAUDE.md` moves to
`~/.avm/AGENTS.md`); fixed Claude-state mounts drop from
`getDockerMountArgs` (replaced by `config.agents_md`-driven mounts);
generator function and template file rename to match; idempotent
migration on first run with a one-time hint. Includes the
`dockerfiles/core.Dockerfile` COPY line removal but **not** the Claude
install removal (that's Task 3, to keep the diffs reviewable). Also
retargets `packages/avm/src/cli/commands/notify.ts`'s `SETTINGS_PATH`
since it imports the now-deleted `avmSystemClaudeDir`.

### Approach

**`packages/avm/src/lib/config.ts`:**

Remove constants:

```ts
// DELETE:
//   avmSystemDir
//   avmSystemSshDir
//   avmSystemGitDir
//   avmSystemClaudeDir
//   avmSystemClaudeJsonFile
//   avmSystemClaudeMdFile
```

Add:

```ts
export const avmAgentsMdFile = path.join(AVM_HOME, "AGENTS.md");
```

`avmMirrorsDir`, `avmVolumesDir`, `avmFilesDir`, daemon constants stay.

**`packages/avm/src/lib/session.ts`:**

Update imports — drop the deleted constants, add `avmAgentsMdFile`.

Replace `generateRootClaudeMd` with `generateAgentsMd`. Body is
unchanged except it writes to `avmAgentsMdFile` and reads from
`templates/agents.md`:

```ts
export function generateAgentsMd(config: AvmConfig): void {
  const template = readFileSync(
    join(REPO_ROOT, "templates", "agents.md"),
    "utf-8",
  );
  const parts = [template.trimEnd()];
  const serviceEntries = Object.entries(config.services);
  if (serviceEntries.length > 0) {
    parts.push("");
    parts.push("## Host services");
    parts.push("");
    parts.push("The following services are available on the host via `avm-bridge`.");
    parts.push("Consult the avm-services skill for usage.");
    parts.push("");
    for (const [name, svc] of serviceEntries) {
      parts.push(`- **${name}** — \`${svc.check.tcp}\``);
    }
  }
  parts.push("");
  writeFileSync(avmAgentsMdFile, parts.join("\n"));
}
```

Update the call site in `ensureHostScaffolding` (was
`generateRootClaudeMd(config)` → `generateAgentsMd(config)`).

Rewrite `ensureHostScaffolding`:

```ts
export function ensureHostScaffolding(): void {
  const requiredDirs = [
    avmMirrorsDir,
    avmVolumesDir,
    avmFilesDir,
    path.join(AVM_HOME, "build-context"),
  ];
  for (const dir of requiredDirs) {
    mkdirSync(dir, { recursive: true });
  }
  migrateLegacyLayout();
  const config = loadAvmConfig();
  generateAgentsMd(config);
}
```

(The legacy `~/.avm/system/` scaffolding directories are no longer
pre-created. The `mkdir`s above plus `migrateLegacyLayout` cover both
fresh installs and upgrades. The empty `claude.json` seeding is dropped
entirely — users running Claude `touch` it themselves per the new
walkthrough.)

Add `migrateLegacyLayout`:

```ts
function migrateLegacyLayout(): void {
  const legacySystem = path.join(AVM_HOME, "system");
  if (!existsSync(legacySystem)) return;

  type Move = {
    src: string;
    dst: string;
    volumeLine: string;   // for the hint snippet
  };
  const moves: Move[] = [
    { src: path.join(legacySystem, "credentials", "ssh"),
      dst: path.join(avmVolumesDir, "ssh"),
      volumeLine: "- ssh:~/.ssh" },
    { src: path.join(legacySystem, "credentials", "git"),
      dst: path.join(avmVolumesDir, "git"),
      volumeLine: "- git:~/.config/git" },
    { src: path.join(legacySystem, "claude"),
      dst: path.join(avmVolumesDir, "claude"),
      volumeLine: "- claude:~/.claude" },
    { src: path.join(legacySystem, "claude.json"),
      dst: path.join(avmVolumesDir, "claude.json"),
      volumeLine: "- claude.json:~/.claude.json" },
  ];

  const moved: Move[] = [];
  for (const m of moves) {
    if (existsSync(m.src)) {
      if (existsSync(m.dst)) {
        console.log(`    [migrate] ${m.dst} already exists — skipped move of ${m.src}`);
      } else {
        mkdirSync(path.dirname(m.dst), { recursive: true });
        renameSync(m.src, m.dst);
        console.log(`    [migrate] ${m.src} → ${m.dst}`);
        moved.push(m);
      }
    }
  }

  // Old CLAUDE.md is regenerated as AGENTS.md by ensureHostScaffolding —
  // delete the legacy file so it doesn't linger.
  const legacyClaudeMd = path.join(legacySystem, "CLAUDE.md");
  if (existsSync(legacyClaudeMd)) {
    rmSync(legacyClaudeMd);
  }

  // Best-effort cleanup of now-empty legacy dirs.
  try { rmdirSync(path.join(legacySystem, "credentials")); } catch {}
  try { rmdirSync(legacySystem); } catch {}

  // Print the config-yaml hint when at least one moved volume isn't yet
  // declared in the user's config.
  printMigrationHintIfNeeded(moves);
}

function printMigrationHintIfNeeded(allMoves: Move[]): void {
  // Determine which moves landed (dst exists, regardless of whether we
  // moved it just now or in a previous run).
  const landed = allMoves.filter((m) => existsSync(m.dst));
  if (landed.length === 0) return;

  // Read the user's volumes and check whether each landed move is declared.
  const config = loadAvmConfig();
  const declaredSources = new Set(
    config.volumes.map((v) => v.source.replace(/^\/+/, "")), // normalize
  );
  const undeclared = landed.filter((m) => {
    // m.volumeLine looks like "- ssh:~/.ssh"; the source token is "ssh".
    const source = m.volumeLine.replace(/^- /, "").split(":")[0];
    return !declaredSources.has(source);
  });
  if (undeclared.length === 0) return;

  console.log();
  console.log("==> Legacy ~/.avm/system layout detected. Files moved to ~/.avm/volumes.");
  console.log("    Declare them in ~/.avm/config.yaml to restore previous behaviour:");
  console.log();
  console.log("      agents_md: ~/CLAUDE.md");
  console.log("      skills_dir: ~/.claude/skills");
  console.log("      volumes:");
  for (const m of undeclared) {
    console.log(`        ${m.volumeLine}`);
  }
  console.log("      integrations:");
  console.log("        claude_notifications: true   # if previously enabled");
  console.log("        claude_desktop: true         # if previously enabled");
  console.log();
  console.log("    Or copy examples/config.yaml as a starting point.");
  console.log();
}
```

Rewrite `getDockerMountArgs`:

```ts
export function getDockerMountArgs(config: AvmConfig): string[] {
  const args: string[] = [];

  // Fixed avm-machinery mounts.
  args.push("-v", `${bridgeBin}:/usr/local/bin/avm-bridge`);
  args.push("-v", `${avmMirrorsDir}:/home/agent/mirrors`);
  args.push("-v", `${avmFilesDir}:/home/agent/.avm-files`);

  // Generated guidance file mounted to each configured target.
  for (const target of config.agents_md) {
    args.push("-v", `${avmAgentsMdFile}:${resolveContainerPath(target)}`);
  }

  // User-declared volumes.
  for (const volume of config.volumes) {
    const resolvedSource = volume.source.startsWith("/")
      ? volume.source
      : path.join(avmVolumesDir, volume.source);
    const resolvedTarget = resolveContainerPath(volume.target);
    if (!existsSync(resolvedSource)) {
      console.warn(
        `    [warn] volume source missing: ${resolvedSource} — skipping mount to ${resolvedTarget}`,
      );
      continue;
    }
    args.push("-v", `${resolvedSource}:${resolvedTarget}`);
  }
  return args;
}

function resolveContainerPath(raw: string): string {
  if (raw.startsWith("/")) return raw;
  if (raw.startsWith("~/")) return `/home/agent/${raw.slice(2)}`;
  return `/home/agent/${raw}`;
}
```

(The old function had its own inline tilde logic for volumes; factor to a
shared helper since `agents_md` uses the same resolution.)

**`dockerfiles/core.Dockerfile`:**

Remove the two-line block:

```dockerfile
COPY templates/vm-claude.md /home/agent/CLAUDE.md
RUN chown agent:agent /home/agent/CLAUDE.md
```

(Match by content, not line numbers — they may have drifted.) The block
provided a static fallback for the generated file; with the host file
always generated by `ensureHostScaffolding` and bind-mounted in, the
COPY is redundant.

Leave the rest of the file intact for this task — the Claude install,
`clauded` alias, and skill COPY are Task 3 / unchanged.

**`packages/avm/src/cli/commands/notify.ts`:**

Replace the import + constant at the top:

```ts
// BEFORE:
import { avmSystemClaudeDir } from "../../lib/config.ts";
const SETTINGS_PATH = join(avmSystemClaudeDir, "settings.json");

// AFTER:
import { homedir } from "node:os";
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
```

Match the convention used by `lib/desktop-config.ts:13`. No other
behaviour in `notify.ts` changes in this task (the install/uninstall
flow rewrite is Task 5).

**`templates/vm-claude.md` → `templates/agents.md`:**

`git mv templates/vm-claude.md templates/agents.md`. Body rewrite is
Task 6 (docs). For Task 2, the file content stays the same — the rename
unblocks the `generateAgentsMd` read path.

Note: `image.ts:62`'s `hashDirectory(path.join(REPO_ROOT, "templates"))`
hashes the entire templates dir, so the rename naturally triggers a
core-image rebuild on next `avm provision`. Nothing to do there.

### Files

- packages/avm/src/lib/config.ts (modify — drop 6 constants, add `avmAgentsMdFile`)
- packages/avm/src/lib/session.ts (modify — add `migrateLegacyLayout`, rewrite `ensureHostScaffolding`, rewrite `getDockerMountArgs`, rename `generateRootClaudeMd` → `generateAgentsMd`, add `resolveContainerPath` helper, add `renameSync`/`rmSync`/`rmdirSync` to the `node:fs` import)
- packages/avm/src/cli/commands/notify.ts (modify — retarget `SETTINGS_PATH` to `join(homedir(), ".claude", "settings.json")` so it doesn't depend on the deleted `avmSystemClaudeDir`)
- dockerfiles/core.Dockerfile (modify — drop the `COPY templates/vm-claude.md /home/agent/CLAUDE.md` + chown block)
- templates/vm-claude.md → templates/agents.md (rename via `git mv`, body unchanged in this task)

### Done criteria

- `pnpm build` succeeds.
- On a fresh-state host (no `~/.avm/system/`), `avm create` runs without
  error, writes `~/.avm/AGENTS.md`, and creates a container with bridge
  bin, mirrors, files, AGENTS.md → `~/AGENTS.md`, and any user-declared
  volumes mounted (no Claude-specific fixed mounts).
- On a legacy host (`~/.avm/system/credentials/ssh` present), `avm create`
  prints the migration log, moves `ssh` and `git` into
  `~/.avm/volumes/`, deletes `~/.avm/system/CLAUDE.md`, and removes the
  empty `~/.avm/system/` directory.
- After migration, `~/.avm/AGENTS.md` exists and contains the current
  template + host-services section.
- The migration hint prints only when at least one moved volume isn't
  declared in `~/.avm/config.yaml volumes:`.
- A second invocation of any `avm` command after migration does not
  re-print the hint *if* the user has declared the moved volumes.

---

## Task 3: De-Claude the core image; ship Claude defaults via examples
- [ ] Status
Depends on: Task 2

### Scope

Strip Claude from `dockerfiles/core.Dockerfile`. Add Claude back as a
clearly-labelled block in `examples/Dockerfile`. Rewrite
`examples/config.yaml` to declare the credentials, Claude state mounts,
guidance redirect, skills dir, and integration toggles needed to
reproduce today's baked-in behaviour verbatim when copied as-is.

### Approach

**`dockerfiles/core.Dockerfile`:**

Make two content-matched edits.

Edit 1 — remove the Claude install block (match by content):

```dockerfile
# --- Claude Code (must run as agent — installs to ~/.claude/) ---

USER agent
RUN curl -fsSL https://claude.ai/install.sh | bash
```

The `USER agent` directive here is what scopes the subsequent
agent-targeted `RUN`s (git config defaults at `~/.config/git/config`,
`mkdir -p ~/work`, the alias `RUN` we're about to trim) to the agent
user. **Keep the `USER agent` line; remove only the Claude install
section header comment and the `curl ... claude.ai/install.sh` line.**
The resulting file looks like:

```dockerfile
USER agent

# --- Git defaults (use XDG path so ~/.gitconfig doesn't shadow bind mounts) ---
RUN mkdir -p ~/.config/git && \
    ...
```

Edit 2 — trim the alias from the combined RUN. Replace:

```dockerfile
RUN echo 'alias clauded="claude --dangerously-skip-permissions"' >> ~/.bashrc && \
    echo 'source /opt/avm/helpers.sh' >> ~/.profile
```

with:

```dockerfile
RUN echo 'source /opt/avm/helpers.sh' >> ~/.profile
```

This `RUN` is still under the `USER agent` scope from Edit 1, so the
`.profile` edit lands at `/home/agent/.profile` (not `/root/.profile`).

The `USER root` directive further down the file (before the helper-script
COPYs) and the trailing `USER agent` / `WORKDIR /home/agent` at the file
end are unchanged.

**`examples/Dockerfile`:**

Append the Claude Code block at the end of the file (after the existing
`USER agent` final line and any trailing content):

```dockerfile
# --- Claude Code -----------------------------------------------------------
# Installs Claude into ~/.claude. The host bind-mounts
# ~/.avm/volumes/claude into ~/.claude (see examples/config.yaml volumes:)
# so login state persists across containers. Remove this section if you use
# a different agent harness.

USER agent
RUN curl -fsSL https://claude.ai/install.sh | bash && \
    echo 'alias clauded="claude --dangerously-skip-permissions"' >> ~/.bashrc
USER root
```

(Trailing `USER root` so any subsequent edits the user adds are not
silently agent-scoped.)

**`examples/config.yaml`:**

Replace the current example content with the Claude-defaults bundle.
Final content:

```yaml
# ~/.avm/config.yaml — Claude Code defaults.
#
# Copying this file as-is reproduces avm's previous baked-in behaviour:
# Claude state and credentials mounted into every container, AGENTS.md
# presented as CLAUDE.md, Claude desktop integration enabled.

# Mount avm's generated guidance file as ~/CLAUDE.md (Claude's
# habit-matching name). Default would be ~/AGENTS.md; both are read by
# Claude Code.
agents_md: ~/CLAUDE.md

# Symlink avm-* skills into Claude's skills directory so the
# in-container agent discovers them via its normal mechanism.
skills_dir: ~/.claude/skills

# Editor used by `avm editor` / `avm-bridge editor open`.
# Allowed: code | cursor | zed. zed requires `avm ssh-config install`.
editor: cursor

# Bind mounts. source is relative to ~/.avm/volumes/ (or absolute);
# target is relative to /home/agent/ (~/ or absolute also accepted).
volumes:
  # Credentials. Drop your SSH key+config into ~/.avm/volumes/ssh
  # and your git config into ~/.avm/volumes/git/config.
  - ssh:~/.ssh
  - git:~/.config/git

  # Claude Code state (persists across containers; shared between them).
  # Create the dirs first: `mkdir -p ~/.avm/volumes/claude` and
  # `touch ~/.avm/volumes/claude.json`.
  - claude:~/.claude
  - claude.json:~/.claude.json

  # Caches — optional but recommended.
  - pnpm-store:~/.local/share/pnpm/store

# Host integrations with Claude Code.
integrations:
  # Forward Claude's Notification/Stop hooks to host notifications
  # (sounds + macOS banners). Run `avm notify install` after enabling.
  claude_notifications: true

  # Register avm containers as SSH environments in Claude desktop.
  # Run `avm ssh-config install` after enabling.
  claude_desktop: true

# Daemon configuration
daemon:
  port: 6970

# Image pruning — `avm provision` builds a new timestamped tag every run.
prune_images:
  enabled: true
  keep_recent: 1

# Optionally declare per-repo symlinks (applied by `avm-bridge link`):
# repos:
#   my-project:
#     symlinks:
#       - envs/my-project.env:.env

# Optionally declare host services managed by the daemon:
# services:
#   chrome:
#     kind: process
#     command:
#       - /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
#       - --remote-debugging-port=9222
#       - --user-data-dir=/tmp/chrome-devtools-profile
#     check:
#       tcp: 127.0.0.1:9222

# Optionally tune host-notification sounds (macOS only):
# notifications:
#   enabled: true
#   sounds:
#     needs-attention:
#       file: /System/Library/Sounds/Ping.aiff
#       volume: 0.7
#     complete:
#       file: /System/Library/Sounds/Submarine.aiff
#       volume: 1.0
```

### Files

- dockerfiles/core.Dockerfile (modify — remove Claude install + alias)
- examples/Dockerfile (modify — append the Claude Code block)
- examples/config.yaml (modify — full rewrite)

### Done criteria

- `avm provision --force` from a clean state builds `avm-core:latest`
  successfully without installing Claude. `docker run --rm avm-core:latest
  which claude` returns non-zero.
- `cp examples/Dockerfile ~/.avm/Dockerfile && cp examples/config.yaml
  ~/.avm/config.yaml && avm provision` produces an `avm:latest` image
  with Claude installed.
- A container created from that image has `clauded` aliased to
  `claude --dangerously-skip-permissions` (per `.bashrc`).
- `examples/config.yaml` parses cleanly through `loadAvmConfig()`; no
  unknown-key warnings.

---

## Task 4: Wire skills_dir into applyPostCreationSetup
- [ ] Status
Depends on: Tasks 1, 2

### Scope

Iterate `config.skills_dir`, run the existing symlink loop for each
target path. Skip when the list is empty.

### Approach

Edit `packages/avm/src/lib/session.ts` `applyPostCreationSetup`. Replace
the current single-target symlink step:

```ts
// --- Symlink image-shipped skills into ~/.claude/skills/ ---
await $`docker exec ${containerName} bash -c ${
  "mkdir -p /home/agent/.claude/skills && " +
  "for d in /opt/avm/skills/*/; do " +
  'ln -sfn "$d" /home/agent/.claude/skills/$(basename "$d"); ' +
  "done"
}`;
```

with a config-driven loop:

```ts
// --- Symlink image-shipped skills into configured skills_dir(s) ---
const config = loadAvmConfig();
for (const raw of config.skills_dir) {
  const target = resolveContainerPath(raw);
  await $`docker exec ${containerName} bash -c ${
    `mkdir -p ${target} && ` +
    `for d in /opt/avm/skills/*/; do ` +
    `ln -sfn "$d" ${target}/$(basename "$d"); ` +
    `done`
  }`;
}
```

When `config.skills_dir` is empty, the loop runs zero times — no symlink
step at all.

`applyPostCreationSetup` doesn't currently take a `config` parameter.
Call `loadAvmConfig()` inside the function (mirroring
`ensureHostScaffolding`). It runs once per `create`/`start`, so the
extra read is negligible. Add `loadAvmConfig` to the top-of-file imports
if not already present.

### Files

- packages/avm/src/lib/session.ts (modify)

### Done criteria

- With `skills_dir: ~/.claude/skills` set, a created container has
  symlinks at `/home/agent/.claude/skills/avm-{repos,docker,services,editor}/`.
- With `skills_dir: [~/.claude/skills, ~/.codex/skills]`, both
  directories receive symlinks.
- With `skills_dir` unset, no `~/.claude/skills` directory is created
  inside the container (verify with `docker exec <name> ls /home/agent/.claude/skills` failing with "No such file or directory" — unless something else created it).

---

## Task 5: Move integrations to config; remove first-run prompts
- [ ] Status
Depends on: Tasks 1, 2

### Scope

Replace `state.desktopConfig.installPrompt` reads with
`config.integrations.claude_desktop`. Same for `state.notifications.installPrompt`
→ `config.integrations.claude_notifications`.
`installDesktopConfig`/`uninstallDesktopConfig` (and the notify
equivalents) flip the config flag via `setConfigIntegration`. Remove the
first-run prompts in `avm create`, `avm provision`, and `avm start`.
Update `--desktop`/`--no-desktop` flags on `avm ssh-config install` and
the existing `--install`/`--no-install` flow on `avm notify` to become
flag-setters that flip config + run the corresponding sync. Delete the
`desktopConfig` and `notifications` subsections from `AvmState`. Delete
the now-dead `maybePromptForInstall` function. `sshConfig.installPrompt`
stays — it's the generic SSH-config Include flag. The daemon-side
`notifications.enabled` master kill-switch in `config.yaml` (read by
`packages/avm-daemon/src/notifications.ts`) is **not** touched; this
task only changes the *install* flag, not the runtime gate.

### Approach

**`packages/avm/src/lib/state.ts`:**

Remove both the `desktopConfig` and `notifications` subsections from
`AvmState` (lines 11-13 and 14-16 in the current shape). The
`sshConfig.installPrompt` subsection stays — it's the generic
SSH-config Include flag.

**`packages/avm/src/lib/desktop-config.ts`:**

Rewrite `installDesktopConfig`:

```ts
export async function installDesktopConfig(): Promise<void> {
  setConfigIntegration("claude_desktop", true);
  await syncDesktopConfig();
}
```

Rewrite `uninstallDesktopConfig`:

```ts
export async function uninstallDesktopConfig(): Promise<void> {
  // Drop avm-owned entries from settings.json regardless of flag state
  // (uninstall is total).
  let dropped = 0;
  if (existsSync(claudeSettingsFile)) {
    const settings = readSettings();
    const existing = settings.sshConfigs ?? [];
    const preserved = existing.filter((e) => !isAvmOwnedEntry(e));
    dropped = existing.length - preserved.length;
    if (dropped > 0) {
      settings.sshConfigs = preserved;
      writeSettings(settings);
    }
  }
  setConfigIntegration("claude_desktop", false);
}
```

(Both lose their previous `InstallDesktopResult`/`UninstallDesktopResult`
return types — replace with `Promise<void>`. Adjust callers in
`commands/ssh-config.ts` to match.)

Add `setConfigIntegration` to the imports.

**`packages/avm/src/lib/ssh-config.ts`:**

Update `syncHostIntegrations` to read from config instead of state:

```ts
export async function syncHostIntegrations(): Promise<void> {
  await syncSshConfig();
  const config = loadAvmConfig();
  if (config.integrations.claude_desktop) {
    await syncDesktopConfig();
  }
}
```

Drop the `readState` import if no longer used in this file.

**`packages/avm/src/cli/commands/notify.ts`:**

Three coordinated edits:

1. **Install action** (currently the `install` subcommand and the body
   inside `maybePromptForInstall`): replace each `updateState({
   notifications: { installPrompt: "installed" } })` call (lines 64,
   202) with `setConfigIntegration("claude_notifications", true)`.

2. **Uninstall action** (lines 87, 97): replace `updateState({
   notifications: { installPrompt: undefined } })` with
   `setConfigIntegration("claude_notifications", false)`.

3. **"Decline" path** (line 205): replace `updateState({ notifications:
   { installPrompt: "declined" } })` with no-op (the entire tri-state
   collapses to "the config flag is true or false"; "declined" no longer
   has meaning).

4. **`printStatus()` (line 135 area):** drop the `promptState =
   state.notifications?.installPrompt ?? "(not asked)"` line and the
   "Install prompt:" output. Replace with reading
   `loadAvmConfig().integrations.claude_notifications` and printing
   "Hooks installed: yes/no" (or equivalent).

5. **`maybePromptForInstall` (line 165-onwards):** delete the function
   entirely. After this task, neither `provision.ts` nor `start.ts`
   calls it (see below).

6. **Imports:** drop `updateState` and `readState` from `state.ts` if no
   longer used after the rewrite. Add `setConfigIntegration` and
   `loadAvmConfig` imports from `config-file.ts`.

The install command's interactive flow simplifies similarly to
`ssh-config install` below: no tri-state prompt; `--install` /
`--no-install` flags (whatever the existing flag names are — preserve
them) become flag-setters. If no flag is passed, the command reads
config and runs the corresponding sync, no prompt.

**`packages/avm/src/cli/commands/create.ts`:**

Delete the entire desktop-registration prompt block (lines 146-166 in
the current file). Keep the SSH-config Include prompt (lines 118-143)
untouched. Drop the `installDesktopConfig` import if it's only used
inside the deleted block.

**`packages/avm/src/cli/commands/provision.ts`:**

Delete the `await maybePromptForInstall();` call (line 54). Drop the
import from `./notify.ts` (line 4).

**`packages/avm/src/cli/commands/start.ts`:**

Delete the `await maybePromptForInstall();` call (line 74). Drop the
import (line 16).

**`packages/avm/src/cli/commands/ssh-config.ts`:**

Rewrite `installSub` to drop the tri-state prompt. New behaviour:

- If `--desktop` is passed: call `installDesktopConfig()` (which sets
  `integrations.claude_desktop: true` and runs sync). Print
  confirmation.
- If `--no-desktop` is passed: call `setConfigIntegration("claude_desktop", false)`.
  Print confirmation.
- If neither is passed: run `installInclude()` only (existing
  behaviour), and consult `loadAvmConfig().integrations.claude_desktop`
  — if `true`, run `syncDesktopConfig()` to make sure settings.json is
  up to date; if `false`, leave settings.json alone. No interactive
  prompt at all.

Rewrite `uninstallSub`:

- Always run `uninstallInclude()`.
- Read `loadAvmConfig().integrations.claude_desktop`. If `true`, call
  `uninstallDesktopConfig()` (which clears the flag + drops settings.json
  entries). Otherwise no-op.
- Drop any references to `state.desktopConfig` (none should remain
  after Task 5's state.ts edit, but verify).

`syncSub` and the root-no-arg handler continue calling
`syncHostIntegrations` — no change needed, they pick up the
config-driven behaviour automatically.

Drop the `select`, `isCancel`, and `readState` imports from this file
if they're no longer used after the rewrite.

### Files

- packages/avm/src/lib/state.ts (modify — drop `desktopConfig` and `notifications` subsections)
- packages/avm/src/lib/desktop-config.ts (modify — install/uninstall use `setConfigIntegration`, drop result types if no longer needed)
- packages/avm/src/lib/ssh-config.ts (modify — `syncHostIntegrations` reads config)
- packages/avm/src/cli/commands/notify.ts (modify — install/uninstall use `setConfigIntegration`; `printStatus` reads config; delete `maybePromptForInstall`; drop updateState/readState imports)
- packages/avm/src/cli/commands/create.ts (modify — delete desktop prompt block, drop unused imports)
- packages/avm/src/cli/commands/provision.ts (modify — delete `maybePromptForInstall` call + import)
- packages/avm/src/cli/commands/start.ts (modify — delete `maybePromptForInstall` call + import)
- packages/avm/src/cli/commands/ssh-config.ts (modify — flags become setters, no prompts, drop unused imports)

### Done criteria

- `pnpm build` succeeds; no references to `state.desktopConfig` or
  `state.notifications` remain anywhere in `packages/avm/src/`. No
  references to `maybePromptForInstall` remain.
- `avm create` on a fresh state prompts only for SSH-config Include
  (one prompt, not two).
- `avm provision` and `avm start` on a fresh state do not prompt for
  notify-install.
- `avm ssh-config install --desktop` sets
  `integrations.claude_desktop: true` in `~/.avm/config.yaml` and
  immediately syncs `~/.claude/settings.json`.
- `avm ssh-config install --no-desktop` sets
  `integrations.claude_desktop: false` and does not write
  `~/.claude/settings.json`.
- `avm ssh-config uninstall` clears the flag in config.yaml and removes
  avm-owned entries from settings.json.
- Equivalent behaviour for `avm notify install` / `--no-notify` (or
  whatever the existing CLI shape is — preserve flag names).
- Editing `integrations.claude_desktop: true` by hand in config.yaml and
  running `avm create` syncs settings.json without any prior install
  command.

---

## Task 6: Documentation rewrite
- [ ] Status
Depends on: Tasks 2, 3, 4, 5

### Scope

Update all user-facing docs to match the new behaviour: README's
First-Time Setup, Host Data Layout, and Customizing sections;
`skills/avm/SKILL.md` first-time-setup and in-container layout sections;
`templates/agents.md` body (post-rename in Task 2); any CLAUDE.md
references in `templates/skills/avm-*/SKILL.md`.

### Approach

**`README.md`:**

Rewrite "First-Time Setup" as the Claude-defaults walkthrough. New
section structure:

```markdown
## First-Time Setup (Claude Code defaults)

`avm` keeps all user-owned state under `~/.avm/`. A fresh install starts
with no `~/.avm/` at all — you create the pieces you need. The walkthrough
below reproduces avm's Claude-flavored defaults. To use a different agent
harness, see the next section.

### 1. Seed credentials and Claude state

```bash
mkdir -p ~/.avm/volumes/{ssh,git,claude}
touch ~/.avm/volumes/claude.json

cp ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub ~/.ssh/config ~/.avm/volumes/ssh/
cp ~/.gitconfig ~/.avm/volumes/git/config
```

Claude Code state (`~/.avm/volumes/claude/` and
`~/.avm/volumes/claude.json`) fills itself in the first time you run
`claude` inside a container — leave them empty to start.

### 2. Drop in the Claude defaults

```bash
cp <avm-repo>/examples/Dockerfile  ~/.avm/Dockerfile
cp <avm-repo>/examples/config.yaml ~/.avm/config.yaml
```

`examples/Dockerfile` ships a reference toolchain (pnpm, Python, Go,
etc.) with a clearly-labelled Claude Code block at the bottom. Edit
both files to match your stack and which integrations you want.

### 3. Build the Docker images

```bash
avm provision
```

### 4. Start a session

```bash
avm create --attach
```

## Using a different agent harness

avm's core image installs no specific agent — that's a Dockerfile
decision. To swap Claude for another harness:

- Strip or replace the "Claude Code" block in `~/.avm/Dockerfile`
  with your harness's install commands.
- In `~/.avm/config.yaml`, remove the `claude:~/.claude` and
  `claude.json:~/.claude.json` volumes (or replace with your harness's
  state paths).
- Set `skills_dir` to your harness's skills directory (or remove
  to skip the symlink step).
- Adjust `agents_md` if your harness reads `AGENTS.md` (the default)
  vs. a different file name.
- Disable `integrations.claude_notifications` and
  `integrations.claude_desktop` unless you're keeping Claude alongside.
```

Update "Host Data Layout" diagram to the new flat layout (no
`~/.avm/system/` subtree; `AGENTS.md` at `~/.avm/AGENTS.md`).

Add or update the "Customizing" subsection on the new config fields:

```markdown
### Customizing the in-container guidance file (AGENTS.md / CLAUDE.md)

avm generates `~/.avm/AGENTS.md` on every command and bind-mounts it
into each container. By default the in-container path is `~/AGENTS.md`.
Override with `agents_md` in `~/.avm/config.yaml`:

    agents_md: ~/CLAUDE.md             # single target
    agents_md: [~/AGENTS.md, ~/CLAUDE.md]  # multiple, e.g. for users
                                            # running both Claude and
                                            # another harness

Set `agents_md: []` to skip the mount entirely.

### Customizing the in-container skills directory

The avm-* skills (avm-repos, avm-docker, avm-services, avm-editor) are
shipped in the image at `/opt/avm/skills/`. Set `skills_dir` to have
them symlinked into one or more harness-specific skill paths:

    skills_dir: ~/.claude/skills
    skills_dir: [~/.claude/skills, ~/.codex/skills]

Unset → no symlinks created.
```

The existing Claude desktop integration and notifications subsections
get a small revision: instead of "saved in state.json", they now say
"controlled by `integrations.claude_desktop` and `integrations.claude_notifications`
in `~/.avm/config.yaml`". The install commands still work as setters.

**`skills/avm/SKILL.md`:**

Update "First-time setup on a fresh machine" section to mirror the new
README walkthrough. Replace CLAUDE.md mentions in the inside-container
layout snippet with AGENTS.md (noting the example sets `agents_md:
~/CLAUDE.md` so habit-matching). Replace references to "saved as
state" for desktop/notify integrations with the config-field model.

**`templates/agents.md`** (the file renamed from `vm-claude.md` in Task 2):

Rewrite the "don't edit this file" sentence to be name-agnostic:

```
Do not edit this file — it is generated by avm on every container start
and your edits will be lost. The mount path depends on your harness's
config (`~/AGENTS.md` by default, `~/CLAUDE.md` when redirected via
`agents_md`). Put persistent user-level instructions in your harness's
own user-level file (e.g. `~/.claude/CLAUDE.md`).
```

The rest of the body — "Do your work in `~/work/`", clone via avm-bridge,
networking notes, etc. — keep as-is. It's all harness-agnostic.

**`templates/skills/avm-*/SKILL.md`:**

Verified at plan-write time: no CLAUDE.md references in any of
`templates/skills/avm-{repos,docker,services,editor}/SKILL.md`. No
edits expected. If the implementer's `grep -ri "CLAUDE.md"
templates/skills/` turns up new references (added since the plan was
written), update them to AGENTS.md or the generic phrasing.

### Files

- README.md (modify — sections: First-Time Setup, Host Data Layout, Customizing)
- skills/avm/SKILL.md (modify — first-time setup section + in-container layout snippet + desktop/notify integration phrasing)
- templates/agents.md (modify — body rewrite for name-agnostic phrasing)

### Done criteria

- README "First-Time Setup" walks through the Claude-defaults flow
  (mkdir/touch, cp Dockerfile, cp config.yaml, avm provision, avm create).
- README has a "Using a different agent harness" subsection naming the
  four knobs to change.
- "Host Data Layout" diagram shows the new flat layout, no `~/.avm/system/`.
- `templates/agents.md` body refers to the file generically; the "don't
  edit" sentence covers both possible mount paths.
- No remaining mentions of `~/.avm/system/credentials/` or
  `~/.avm/system/CLAUDE.md` outside of the migration narrative.
- `grep -ri "CLAUDE.md" templates/ skills/` returns only intentional
  references (e.g. naming the file when explaining the redirect).

---

## Task 7: Manual end-to-end verification
- [ ] Status
Depends on: Tasks 2, 3, 4, 5, 6

### Scope

Walk through the three primary scenarios from the spec plus the edge
cases that are cheap to exercise. Record outcomes in the task `### Result`
block. No code changes.

### Approach

Run on a host with avm previously installed and exercised (so legacy
`~/.avm/system/` is present). Back up `~/.avm/` and `~/.claude/settings.json`
before starting; restore at the end.

1. **Backup:**
   - `cp -r ~/.avm ~/.avm.bak`
   - `cp ~/.claude/settings.json ~/.claude/settings.json.bak`

2. **Migration scenario:**
   - Run `avm provision`.
   - Verify the migration log shows the moves
     (`system/credentials/ssh → volumes/ssh`, etc.).
   - Verify `~/.avm/system/` is gone or empty.
   - Verify `~/.avm/volumes/{ssh,git,claude,claude.json}` exist with
     content preserved.
   - Verify `~/.avm/AGENTS.md` exists.
   - Verify the migration hint prints with the config.yaml snippet.

3. **Apply migration hint:**
   - Edit `~/.avm/config.yaml` per the hint (or `cp examples/config.yaml`).
   - Run `avm provision` again.
   - Verify the hint no longer prints.

4. **Fresh container (Claude defaults):**
   - `avm create --attach`
   - Inside: `ls -la ~/CLAUDE.md` (mounted), `ls ~/.claude/skills`
     (avm-* skills symlinked), `which claude` (installed),
     `clauded --help` (alias works).
   - Verify SSH/git creds present.
   - Verify Claude login state persists across `avm clean` + new `avm create`.

5. **Fresh install scenario (clean slate):**
   - Move `~/.avm` aside: `mv ~/.avm ~/.avm.clean-test-backup`
   - Follow the new README "First-Time Setup" verbatim.
   - Verify a working container at the end.
   - Restore: `rm -rf ~/.avm && mv ~/.avm.clean-test-backup ~/.avm`

6. **Different-harness scenario (smoke test, no actual non-Claude
   harness needed):**
   - Edit `~/.avm/config.yaml`: comment out the Claude volumes
     (`claude`, `claude.json`), set `agents_md: ~/AGENTS.md`, unset
     `skills_dir`, disable both integrations.
   - `avm create --attach`.
   - Inside: `ls -la ~/AGENTS.md` (mounted as AGENTS.md, not CLAUDE.md),
     `ls /home/agent/.claude/skills` should fail (no skills dir created),
     credentials still present.
   - `avm clean <id>`. Restore the Claude config.yaml.

7. **Edge cases:**
   - **`agents_md: []`** — set to empty, `avm create`, verify no
     guidance file mount in `docker inspect`.
   - **Multiple `agents_md` targets** — set to
     `[~/AGENTS.md, ~/CLAUDE.md]`, `avm create`, verify both files exist
     in container with same content.
   - **`agents_md` with unsafe chars** — set to `~/foo$bar`, verify
     `loadAvmConfig` throws with a clear error.
   - **Existing `~/.avm/volumes/ssh` blocks legacy move** — manually
     create `~/.avm/volumes/ssh` with a file, run any avm command,
     verify the migration log says "skipped" without overwriting.
   - **`integrations.claude_desktop` toggle without install command** —
     edit config.yaml to set `true`, run `avm create`, verify
     `~/.claude/settings.json` `sshConfigs` updates.

8. **`avm ssh-config install --desktop` / `--no-desktop`:**
   - With `claude_desktop: false` in config: `avm ssh-config install --desktop`
     flips it to `true`, syncs settings.json.
   - With `claude_desktop: true`: `avm ssh-config install --no-desktop`
     flips it to `false`, does not touch settings.json.
   - `avm ssh-config uninstall` clears the flag and drops avm-owned
     entries.

9. **Restore:** `rm -rf ~/.avm && mv ~/.avm.bak ~/.avm`, restore
   `~/.claude/settings.json` if needed.

### Files

(no code changes; verification only)

### Done criteria

- All eight verification scenarios pass with the documented behaviour.
- Migration is non-destructive on a real legacy state.
- Claude defaults reproduce today's behaviour via composition.
- Non-Claude config produces a container with no Claude leftovers
  (skills dir absent, no `~/CLAUDE.md`, no Claude state mounts).
- Integration flags drive the corresponding behaviour without state.json
  involvement.
- The `### Result` block on this task records the outcome of each step.
