# avm Generalization — Design Spec

**Date:** 2026-04-10
**Status:** Design

## Summary

Strip Alcova-specific content from the `avm` project and make it a generic harness for running sandboxed Claude Code agents in OrbStack VMs. User-specific state, base-VM setup, and per-repo overlays become user-owned and config-driven. The CLI remains a thin wrapper over `orb` and SSH.

## Goals

- Remove hardcoded Alcova references (GitHub org, repo list, Go/Atlas/Task toolchain, GOPRIVATE, URL rewrites) from the repo.
- Move user state (mirrors, credentials, caches, per-repo files, Claude Code home) out of the repo into `~/.avm/`.
- Let users provide a bash setup script that installs whatever toolchain they need on top of a minimal core base VM.
- Declare bind mounts and per-repo symlinks in a docker-compose-style `~/.avm/config.yaml`.
- Keep `avm` a thin wrapper — no state service, no schemas stored anywhere beyond the YAML file.
- Split `avm start` into two commands: `avm create` (new VMs) and `avm start` (resume stopped VMs). This aligns avm's verbs with `orb`'s (`orb create` + `orb start`) and `docker`'s equivalents, and removes the overload where "start" currently means "create-and-start."

## Non-Goals

- Auto-migration from the current `<repo>/data/` layout. The current single user (me) will delete old VMs and move files manually.
- Backwards compatibility with the `alcova-base` template name or any Alcova-era paths.
- Publishing to npm. If this ever happens it'll be under a scoped name (`@marcporciuncula/avm`), not a package-name change.
- Cross-platform support beyond macOS + OrbStack. Unchanged.
- Automated tests. Unchanged.
- Any in-VM abstraction beyond what `/opt/avm/helpers.sh` offers the user's setup script.

## Architecture Overview

Two moving parts change shape:

1. **Host state moves from `<repo>/data/` to `~/.avm/`.** The repo becomes pure code. Every host file that matters to a user's VM sessions lives under their home directory.
2. **Base VM provisioning splits into core + user.** The CLI provisions a minimal Ubuntu + `agent` + Node + Claude Code + helpers. The user's `~/.avm/setup.sh` layers any toolchain on top.

Everything else — the CLI command surface, SSH/orb orchestration, prefix resolution, session management — stays the same.

## `~/.avm/` Layout

```
~/.avm/
├── config.yaml           # user-edited: volumes + per-repo config
├── setup.sh              # user-written: base VM setup script
├── system/               # fixed layout; user populates, avm mounts
│   ├── credentials/
│   │   ├── ssh/          # GitHub SSH keys + ssh config → ~/.ssh in VM
│   │   └── git/
│   │       └── .gitconfig # git identity → ~/.gitconfig in VM (copied)
│   ├── claude/           # Claude Code home → ~/.claude in VM
│   └── claude.json       # Claude Code settings → ~/.claude.json in VM
├── mirrors/              # optional bare git mirrors → ~/mirrors in VM
├── volumes/              # bind-mount sources (declared in config.yaml)
│   ├── pnpm-store/
│   ├── go-build/
│   └── cargo/
└── files/                # symlink sources (declared in config.yaml)
    ├── envs/
    │   └── operator-ui.env
    └── configs/
        └── alcova-backend/local.yml
```

**Three kinds of subdirectory in `~/.avm/`:**

- **`system/` — fixed layout, authentication state.** Holds the credentials and persistent Claude state that every session VM needs to talk to GitHub and run Claude Code. The paths inside are avm-defined: `credentials/ssh/` means "the SSH dir", `credentials/git/.gitconfig` means "the git identity", `claude/` means "Claude Code home", `claude.json` means "Claude Code settings". The user populates these with their own files; the CLI doesn't generate any of them. On a fresh machine the user can do this manually, or have the host-side Claude (via the `avm` skill) walk them through it — generate an SSH key, set up a git identity, drop `.gitconfig` in place. The CLI's job is to know these paths and bind-mount them into every session VM.
- **`mirrors/` — fixed bind location, optional content.** Bare git mirrors the agent can reference-clone from inside the VM for fast clones of large repos. The directory is always bind-mounted to `~/mirrors/` in the VM (known location — the in-VM CLAUDE.md tells the agent to use it). Populating it is optional; an empty `mirrors/` just means the agent does regular clones without the `--reference` speedup. Users populate with `git clone --mirror git@github.com:org/repo.git ~/.avm/mirrors/repo.git` or similar.
- **`volumes/` and `files/` — user-chosen layouts.** These are the sources referenced by `config.yaml`. Users organize them however makes sense for their stack. The CLI reads `config.yaml`, resolves sources relative to these directories, and applies the declared mounts/symlinks. No fixed structure, no reserved subdirectory names.

In effect, `system/` is "the configuration file for the parts of avm you can't express in `config.yaml`." A fresh clone of `avm` + `pnpm link --global` starts with an empty `~/.avm/system/` and `~/.avm/mirrors/`; the user fills them in during First-Time Setup (or is guided through it by the skill).

**Why `files/` exists as a separate mount:** `volumes[]` entries become proper bind mounts directly from their source on the host to their target in the VM, so they don't need an intermediate mount. `repos.*.symlinks[]` entries become `ln -s` calls inside the cloned repo working directory — for the symlink target to resolve to anything real, the source file must be visible in the VM. The `files/` directory is bind-mounted once as a whole to `~/.avm-files/` inside the VM, and symlinks point into it. Keeping symlink sources in their own top-level directory also prevents users from accidentally declaring a symlink that points into `volumes/` or `credentials/`.

## Config File

Path: `~/.avm/config.yaml`. Format: YAML, docker-compose-inspired.

```yaml
# ~/.avm/config.yaml

# Bind mounts applied to every VM session on `avm create` or `avm start`.
# source is relative to ~/.avm/volumes/
# target is relative to /home/agent/ (or absolute if starting with /)
volumes:
  - pnpm-store:~/.local/share/pnpm/store
  - go-build:~/.cache/go-build
  - go-mod:~/go/pkg/mod
  - cargo:~/.cargo

# Per-repo config. Applied by `avm-link` inside the VM after the agent
# clones a repo from a mirror.
repos:
  operator-ui:
    symlinks:
      - envs/operator-ui.env:.env
  alcova-backend:
    symlinks:
      - envs/alcova-backend.env:.env
      - configs/alcova-backend/local.yml:config/local.yml
      - configs/alcova-backend/docker-compose.override.yml:docker-compose.override.yml
```

### Resolution Rules

- `volumes[].source` — relative to `~/.avm/volumes/`. Absolute paths are also allowed (rare but supported).
- `volumes[].target` — relative to `/home/agent/` unless absolute. Supports `~/` expansion.
- `repos.<name>.symlinks[].source` — relative to `~/.avm/files/`.
- `repos.<name>.symlinks[].target` — relative to the current working directory when `avm-link` runs (which is the repo's working copy for the standard workflow, e.g. `~/work/<name>/`).
- `<name>` in `repos:` is the lookup key used by `avm-link`. It's whatever the user (or the agent) passes as the first arg to `avm-link`, defaulting to `$(basename "$PWD")`. By convention it matches a mirror basename at `~/.avm/mirrors/<name>.git`, but there's no hard requirement — `avm-link` is just doing a case-statement lookup on the name.
- File vs. directory is auto-detected by stat'ing the source.
- A missing source is a warning, not an error. This lets a single `config.yaml` work across VMs where some caches haven't been populated yet, and across repos where not every repo has every config file.
- A `repos:` entry without a corresponding mirror is still useful — the agent can clone from anywhere (not just a mirror) and then run `avm-link` to apply the configured symlinks.

### Validation

- Strict schema: unknown keys at any level are errors, not warnings. A typo silently doing nothing is the worst outcome.
- Short form only (`source:target`). Long-form object entries (`{source, target, type, read_only}`) are not supported in v1. Adding them later is additive and won't break existing configs.
- The config file is **optional**. If `~/.avm/config.yaml` is missing, the VM comes up with system mounts only, no user volumes, no repo symlinks. Adding the file is a progressive enhancement.
- Implementation: YAML parsing via the `yaml` npm package. Validation is a small hand-rolled checker — no zod or other dependency.

## Base VM Provisioning Split

`avm provision` flow:

1. **Core provisioning (CLI-owned, ~50 lines in `lib/base-vm.ts`):**
   1. `orb create -u agent ubuntu avm-base`
   2. apt install: `build-essential`, `curl`, `wget`, `git`, `jq`, `unzip`, `zip`, `tar`, `openssh-client`, `ca-certificates`, `gnupg`, `pkg-config`
   3. git defaults: `init.defaultBranch=main`, `pull.rebase=true`
   4. Node 24 via NodeSource (Claude Code requires Node)
   5. Claude Code via the official installer
   6. `clauded` alias in agent's `.bashrc`
   7. `mkdir ~/work`
   8. Install helpers library at `/opt/avm/helpers.sh` (see below)

2. **User provisioning (`~/.avm/setup.sh`, runs as root inside the VM):**
   - Base VM's `/mnt/mac` mount gives it read access to the host's `~/.avm/setup.sh` at `${vmHostAvmHome}/setup.sh`. The lockdown that masks `/mnt/mac` only applies to session VMs, not the template.
   - CLI runs a single root command inside the VM: `cp ${vmHostAvmHome}/setup.sh /tmp/avm-user-setup.sh && bash /tmp/avm-user-setup.sh && rm /tmp/avm-user-setup.sh`.
   - If `setup.sh` exits non-zero, the whole provision fails loudly and the partially-provisioned base VM is left for the next `avm provision` to delete and rebuild from scratch.

3. **Stop the VM** — `orb stop avm-base`. Template ready.

If `~/.avm/setup.sh` does not exist, `avm provision` exits with an error:

```
Error: ~/.avm/setup.sh not found.
See examples/setup.sh in the avm repo for a starting point:
  cp <avm-repo>/examples/setup.sh ~/.avm/setup.sh
```

The user is expected to seed their own setup script once, on first install.

## Helpers Library

The core provisioner installs `/opt/avm/helpers.sh`:

```bash
# Source from your ~/.avm/setup.sh for standard helpers.
# The script itself runs as root; use as_agent to drop to the agent user.

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

The helpers are intentionally minimal. Users can add more in their own script; the CLI doesn't promise backwards compatibility for anything not listed here. If a pattern becomes common enough to warrant adding, add it explicitly rather than implicitly via evolution.

## Command Split: `avm create` and `avm start`

`avm start` today both creates new VMs and errors on any existing name. This spec splits that into two commands:

- **`avm create [name] [--attach]`** — creates a fresh session VM. Errors if a VM with the given name already exists. This is the old `avm start` create path, renamed.
- **`avm start <id> [--attach]`** — resumes a stopped session VM. Errors if the VM is already running or doesn't exist.

Neither command takes a `--clone` flag. Cloning repos is the agent's job inside the VM, documented in `templates/vm-claude.md`. The CLI's role is to make the mirrors, symlink sources, and `avm-link` helper available; the agent does the actual `git clone` and post-clone `avm-link` invocation. This removes a whole code path from the CLI and deletes the duplication where the create flow and the agent's workflow both knew how to clone a repo.

### `avm create [name]`

1. **If no name** → generate a random name via `generateSessionName()`.
2. **If name given** → normalize via `normalizeVmName(name)`.
3. Look up the name in `listAvmVms()`:
   - **Exists (any status)** → error: `VM <name> already exists. Use 'avm start <id>' to resume it, or 'avm clean <id>' to delete and recreate.` Exit non-zero.
   - **Not found** → proceed with the create flow below.
4. **Create flow** (orchestration):
   1. Read `~/.avm/config.yaml` (tolerate absence: treat as empty `volumes` and empty `repos`).
   2. `orb clone avm-base <name>`, `orb start <name>`, wait for SSH.
   3. Call `applySessionMounts(name, config)` (see below).
   4. Call `applyLockdown(name)`.
   5. Print the SSH command. If `--attach`, exec into SSH.

### `avm start <id>`

1. **Id argument required.** If missing, error: `avm start requires a VM id. Use 'avm create' to start a new session.`
2. Resolve the id via `resolveVmByPrefix(args.id, await listAvmVms())`, the same helper `attach`, `stop`, and `clean` use:
   - **No match** → `resolveVmByPrefix` throws `No VM matching "<id>".`; print the error plus the hint `Use 'avm list' to see sessions, or 'avm create <name>' to start a new one.` and exit non-zero.
   - **Ambiguous prefix** → `resolveVmByPrefix` throws with the candidate list; surface verbatim and exit non-zero.
   - **Unique match, already running** → error: `VM <name> is already running. Use 'avm attach <id>' to connect.`
   - **Unique match, stopped** → proceed with the resume flow below.
3. Prefix matching on `avm start` mirrors `attach`, `stop`, and `clean`. The earlier "exact only" stance was motivated by a concern that's no longer reachable: now that `avm start` can't create, every input refers to a VM that already exists, and `resolveVmByPrefix` already errors on ambiguous matches. Consistency across the id-consuming commands wins.
4. **Resume flow** (orchestration):
   1. Read `~/.avm/config.yaml` (tolerate absence).
   2. `orb start <name>`, wait for SSH. **No** `orb clone` — the VM already exists.
   3. Call `applySessionMounts(name, config)`. Bind mounts don't persist across `orb stop`, so every resume has to redo them from scratch. This also regenerates `/usr/local/bin/avm-link` so config.yaml changes take effect on resume.
   4. Call `applyLockdown(name)`.
   5. Print the SSH command. If `--attach`, exec into SSH.

Existing working copies in `~/work/` persist across stop/start — they're part of the VM's own disk, not a bind mount — so the agent's clones from the previous session are still there after resume.

### Shared Orchestration Helpers

Extract the mount and lockdown logic into reusable functions so the create and resume flows share one code path. Home: a new `lib/session.ts`. Both `cli/commands/create.ts` and `cli/commands/start.ts` import from it. Rationale: the project convention (per `CLAUDE.md`) is that command files are self-contained and read shared logic from `lib/`, not from each other. Putting the helpers in `start.ts` would force `create.ts` to import across the `commands/` boundary; the new `lib/` file respects the convention from day one and keeps both command files small. Names below are illustrative.

**`applySessionMounts(vmName, config)`** — idempotent setup of all mounts that must exist on every session start:

1. **Fixed mounts** (always on, not configurable):
   - `~/.avm/system/credentials/ssh/` → `/home/agent/.ssh`
   - `~/.avm/system/claude/` → `/home/agent/.claude`
   - `~/.avm/system/claude.json` → `/home/agent/.claude.json` (file bind mount)
   - `~/.avm/mirrors/` → `/home/agent/mirrors`
   - Copy `~/.avm/system/credentials/git/.gitconfig` → `/home/agent/.gitconfig` (plain copy, not a mount)
2. **`files/` holding mount:** `~/.avm/files/` → `/home/agent/.avm-files/`
3. **User volumes** from `config.volumes`: for each entry, `mount --bind ~/.avm/volumes/<source>/ <target>`, resolving `<target>` relative to `/home/agent/` unless absolute. Warn (don't fail) if the source path doesn't exist.
4. **Write `/usr/local/bin/avm-link`** generated from `config.repos` (see the "Generated avm-link" section).
5. **Seed `~/.avm/system/claude/CLAUDE.md`** from the repo's `templates/vm-claude.md` if missing. Once seeded, the user edits it freely; the CLI never overwrites an existing file. This is a host-side operation; safe to run on every start (it's a no-op after the first time).

All mount commands are pre-`mkdir -p` on the target, and use `mount --bind` without `-o bind,ro` (read-write everywhere — we rely on lockdown, not mount permissions, for isolation).

**`applyLockdown(vmName)`** — bind-mounts empty directories over `/mnt/mac` and `/Users`. Identical to today's lockdown logic.

There's deliberately no `applyClone` helper. Cloning repos is the agent's responsibility inside the VM, guided by the in-VM CLAUDE.md. The CLI's job is to make the tools available (`~/mirrors/` populated, `~/.avm-files/` mounted, `avm-link` installed) and get out of the way.

## Generated `avm-link`

On both `avm create` and `avm start`, the CLI reads `config.yaml` and generates a bash script at `/usr/local/bin/avm-link` inside the VM. Written as root before lockdown. Generation happens inside `applySessionMounts`, so both commands use the same code path and resumed VMs always pick up the latest config.

Example output for the example config above:

```bash
#!/bin/bash
# Generated by avm — do not edit
set -e
repo="${1:-$(basename "$PWD")}"
case "$repo" in
  operator-ui)
    ln -sf "$HOME/.avm-files/envs/operator-ui.env" .env
    ;;
  alcova-backend)
    ln -sf "$HOME/.avm-files/envs/alcova-backend.env" .env
    mkdir -p config
    ln -sf "$HOME/.avm-files/configs/alcova-backend/local.yml" config/local.yml
    ln -sf "$HOME/.avm-files/configs/alcova-backend/docker-compose.override.yml" docker-compose.override.yml
    ;;
  *)
    exit 0
    ;;
esac
```

### Usage Model

- `avm-link` with no argument reads the repo name from `$(basename "$PWD")`. Intended to be run from inside a freshly cloned repo working directory.
- `avm-link <name>` uses the explicit name. Useful when cloning into a non-standard path.
- Exits 0 with no action for repos that have no configured symlinks.
- `avm-link` is the single source of truth for applying per-repo symlinks. The CLI never calls it directly — the agent invokes it after cloning.

### Generation Rules

- For each target containing a `/` (e.g. `config/local.yml`), emit `mkdir -p <dirname>` before the `ln -sf` so it never fails on missing parent dirs. Targets without a slash (e.g. `.env`) skip the `mkdir`.
- Use `ln -sf` so re-running is idempotent.
- The script uses `$HOME/.avm-files/...` so it's independent of the actual user (future-proofs if we ever rename `agent`).
- All paths are written with shell-safe double quotes in case any source path contains spaces.

## Removals

### `lib/config.ts`

Delete:
- `GITHUB_ORG`
- `REPO_DEPS`
- `ALL_REPOS`
- `LEGACY_BASE_VM_NAME` (user decision: no compat code; delete old VMs manually)
- `dataDir`, `mirrorsDir`, `credentialsDir`, `envsDir`, `cacheDir`, `claudeDir`, `claudeJsonFile`

Keep:
- `BASE_VM_NAME = "avm-base"`
- `REPO_ROOT` — still needed for shipping `templates/` and `examples/` from the repo

Add:
- `AVM_HOME = path.join(os.homedir(), ".avm")`
- `avmSystemDir = path.join(AVM_HOME, "system")`
- `avmSystemSshDir = path.join(avmSystemDir, "credentials/ssh")`
- `avmSystemGitConfigFile = path.join(avmSystemDir, "credentials/git/.gitconfig")`
- `avmSystemClaudeDir = path.join(avmSystemDir, "claude")`
- `avmSystemClaudeJsonFile = path.join(avmSystemDir, "claude.json")`
- `avmMirrorsDir = path.join(AVM_HOME, "mirrors")` (lifted to top level — mirrors aren't `system/`)
- `avmVolumesDir = path.join(AVM_HOME, "volumes")`
- `avmFilesDir = path.join(AVM_HOME, "files")`
- `avmConfigFile = path.join(AVM_HOME, "config.yaml")`
- `avmSetupScript = path.join(AVM_HOME, "setup.sh")`
- `vmHostAvmHome = /mnt/mac${AVM_HOME}` — the pre-lockdown path to `~/.avm` from inside the VM

### `cli/commands/provision.ts`

Delete:
- `LEGACY_BASE_VM_NAME` migration block (the one that finds and deletes an old `alcova-base` VM).

Add:
- Precondition check: if `~/.avm/setup.sh` doesn't exist, error out with the message from the "Base VM Provisioning Split" section.

### `lib/base-vm.ts`

Delete every install step that isn't in the core list:
- Python3 install
- Buf CLI
- Go install + GOPRIVATE config
- Atlas CLI
- Task install
- golangci-lint
- staticcheck
- Docker install + agent group
- Git URL rewriting for Alcova-AI

Keep and reorganize so the function ends with:
- Install `/opt/avm/helpers.sh` (new)
- Copy `~/.avm/setup.sh` to the VM and execute as root (new)
- `orb stop avm-base`

### `cli/commands/start.ts` and new `cli/commands/create.ts`

Split the current single `start` command into two:

- **`cli/commands/create.ts`** (new) — owns the old create flow. Command metadata: `name: "create"`, description: "Create and start a new agent VM." Args: optional positional `name`, `--attach`. Implementation follows the `avm create` flow in the "Command Split" section above.
- **`cli/commands/start.ts`** (rewritten) — owns the new resume flow. Command metadata: `name: "start"`, description: "Resume a stopped agent VM." Args: required positional `id`, `--attach`. Implementation follows the `avm start` flow in the "Command Split" section above.

Shared orchestration (`applySessionMounts`, `applyLockdown`) lives in `lib/session.ts` — see "Shared Orchestration Helpers" above. Both command files import from there.

Register both commands in `cli/avm.ts`:

```typescript
subCommands: {
  list: listCommand,
  create: createCommand,      // new
  start: startCommand,        // rewritten — now resume-only
  attach: attachCommand,
  stop: stopCommand,
  clean: cleanCommand,
  provision: provisionCommand,
},
```

Both commands use the new paths (`~/.avm/system/*`, `~/.avm/volumes/*`, `~/.avm/files/*`) and the new config-driven mount/symlink logic. Neither uses `ALL_REPOS`, `REPO_DEPS`, or `GITHUB_ORG` — these are deleted from `lib/config.ts`.

### `templates/vm-claude.md`

Rewrite as a generic in-VM CLAUDE.md seed:
- Describes the standard paths (`~/work/`, `~/mirrors/`, `~/.avm-files/`)
- Describes `avm-link` usage
- Describes `clauded` alias
- No Alcova repo references
- No Go/Atlas/Task/GOPRIVATE sections

### `README.md`, `CLAUDE.md`, `skills/avm/SKILL.md`

Strip Alcova-specific language throughout. Document:
- The new `~/.avm/` layout (`system/`, `mirrors/`, `volumes/`, `files/`, `config.yaml`, `setup.sh`)
- Config file format and resolution rules
- `setup.sh` and `/opt/avm/helpers.sh`
- `avm-link` usage inside the VM
- The command split (`avm create` vs `avm start`)
- No `--clone` flag — cloning is the agent's job; the in-VM CLAUDE.md tells it how
- No auto-migration from old layout — users start fresh

`skills/avm/SKILL.md` additionally gains a "First-time setup on a fresh machine" section so the host-side Claude can guide users through populating `~/.avm/system/` — generating an SSH key, setting up a git identity, dropping `.gitconfig` in place, creating an initial mirror or two. This makes the skill a real onboarding assistant, not just a runtime command reference.

## New: `examples/setup.sh`

Ship a working example that mirrors the current Alcova toolchain (Go, Atlas, Task, Buf, golangci-lint, staticcheck, Docker, GOPRIVATE, URL rewriting for Alcova-AI). Users copy it verbatim on day one:

```bash
cp <avm-repo>/examples/setup.sh ~/.avm/setup.sh
```

This is the bash-translation of the content currently in `lib/base-vm.ts`. Committed to the repo so new users (or I on a fresh machine) don't start from scratch. Users edit freely afterward — `examples/setup.sh` is never re-copied once `~/.avm/setup.sh` exists.

The example should source `/opt/avm/helpers.sh` and use `as_agent` / `echo_step` to demonstrate the pattern.

## `lib/config.ts` Path Semantics Detail

The CLI needs two views of `~/.avm/`:

1. **Host-side paths** — plain filesystem paths on macOS used by `fs` operations and passed into host-side commands like `git fetch` on a mirror.
2. **VM-side paths** — paths as seen from inside the VM, specifically through `/mnt/mac/...` before the host filesystem lockdown.

Today, `vmHostPrefix = /mnt/mac${REPO_ROOT}` points at the repo inside the VM. After this change, that's no longer useful — user state isn't in the repo. Replace with:

```ts
export const vmHostAvmHome = `/mnt/mac${AVM_HOME}`;
```

All VM-side bind-mount sources use `${vmHostAvmHome}/system/...`, `${vmHostAvmHome}/volumes/...`, `${vmHostAvmHome}/files/...`. The lockdown still only masks `/mnt/mac` and `/Users`; the individual bind mounts point into `${vmHostAvmHome}` *before* lockdown, so the mounted content remains visible at its target paths after.

## First-Run Experience

A brand-new clone of `avm` + `pnpm link --global` does nothing useful on its own. To get a working session the user needs at minimum:

1. `~/.avm/system/credentials/ssh/` — SSH key(s) and config for GitHub
2. `~/.avm/system/credentials/git/.gitconfig` — git identity
3. `~/.avm/setup.sh` — base VM setup script
4. `avm provision` — build the base VM
5. `avm create` — create and start a session

The README's "First-Time Setup" section walks through these five steps in order. We do not auto-scaffold `~/.avm/` — the user creates the directories themselves (or via `cp -r` from the repo's examples). Scaffolding would be code to debug for a one-time operation.

Optional after step 3, for a faster agent workflow:
- Populate `~/.avm/mirrors/` with bare clones of frequently-used repos so the agent can do `git clone --reference` against them.
- Populate `~/.avm/files/envs/<repo>.env` and/or `~/.avm/files/configs/<repo>/*` with per-repo overlays.
- Populate `~/.avm/volumes/<name>/` with empty directories for caches (they fill as you use them).
- Create `~/.avm/config.yaml` declaring the volumes and repo symlinks.

## Component Boundaries

| Component | Owner | Lives In | Changes Here? |
|---|---|---|---|
| CLI entrypoint + command wiring | CLI | `cli/avm.ts`, `cli/commands/*` | Add `create`, rewrite `start`, mount setup, provision |
| Host path constants | CLI | `lib/config.ts` | Rewritten — see removals |
| Base VM core provisioner | CLI | `lib/base-vm.ts` | Shrunk to minimal core |
| Base VM user provisioner | User | `~/.avm/setup.sh` | New — runs after core |
| Config parsing + validation | CLI | `lib/config-file.ts` (new) | New — reads `~/.avm/config.yaml` |
| Mount orchestration | CLI | `lib/session.ts` | New — shared by `create` and `start` |
| `avm-link` generator | CLI | `lib/config-file.ts` | New — exported for `lib/session.ts` to call |
| Mirrors helpers | — | `lib/mirrors.ts` | **Deleted** — was only used by `--clone` flow |
| VM helpers library | CLI (installed into VM) | `templates/vm-helpers.sh` (new) | New |
| In-VM CLAUDE.md seed | CLI | `templates/vm-claude.md` | Rewritten generic |
| Example setup script | CLI (ships as example) | `examples/setup.sh` | New |

New file: `lib/config-file.ts`. Responsibilities:
- Read `~/.avm/config.yaml`
- Parse YAML via the `yaml` package
- Validate schema (strict; unknown keys error)
- Return a typed `AvmConfig` object
- Export a `generateAvmLinkScript(config): string` function called by `lib/session.ts`

Keeping this in its own file keeps `start.ts` focused on orchestration and makes the config logic independently understandable.

## Risks and Open Questions

- **Strict validation + typos in config.yaml.** A typo in `volumes` vs `volume` must produce a clear error pointing at the line number. YAML parsers generally expose this; verify the `yaml` package does when we implement.
- **Generated `avm-link` is per-VM, not shared state.** Editing `~/.avm/config.yaml` after starting a session does not update running VMs. The next `avm create` (fresh session) or `avm start <id>` (resume) regenerates the script and picks up the latest config. Document this clearly so users don't wonder why their edit isn't taking effect.
- **`files/` mount persistence.** The `~/.avm/files/` bind mount must survive the host filesystem lockdown. Since we mount it at `/home/agent/.avm-files/` (inside the agent home, not under `/mnt/mac`), the lockdown of `/mnt/mac` and `/Users` doesn't touch it — same pattern as the current `~/mirrors` mount. Verified against the current lockdown logic.
- **Copy sources (future).** The spec reserves space for a future `copies:` key in repo entries alongside `symlinks:`. Not implemented in v1. When added, copies will resolve sources under `~/.avm/files/` the same way symlinks do.
- **`setup.sh` failure modes.** If the user's setup script fails partway through, the base VM is in an unknown state. `avm provision` should surface the failure (non-zero exit, show stderr) and the next invocation will delete and rebuild from scratch. Same resilience model as today.
- **Helpers library API.** Once `as_agent` and `echo_step` are documented as available, they're effectively a public API for user scripts. Changing their signatures is a breaking change. Keep the surface minimal to reduce this burden.

## Out of Scope

- `copies:` support in repo config
- Long-form volume/symlink entries with explicit `type:` and `read_only:`
- Env var injection into VMs (beyond whatever `~/.gitconfig` and ssh config provide)
- Port forward declarations (OrbStack handles this automatically)
- Multiple config files or include/import mechanisms
- Any kind of hook system beyond the single `setup.sh`
- Lifecycle hooks (pre/post clone, pre/post start)
- Renaming the `agent` user

## Summary of File Changes

**New:**
- `cli/commands/create.ts` — new `avm create` command (owns the old create flow from `start.ts`)
- `examples/setup.sh` — working example user script (bash translation of current `lib/base-vm.ts` Alcova content)
- `templates/vm-helpers.sh` — VM-side `as_agent`/`echo_step` shell helpers (installed at `/opt/avm/helpers.sh` in VMs)
- `lib/config-file.ts` — YAML parsing, validation, `avm-link` generation
- `lib/session.ts` — shared `applySessionMounts` + `applyLockdown` helpers called by `create` and `start`

**Rewritten:**
- `lib/config.ts` — paths point at `~/.avm/`, Alcova constants deleted
- `lib/base-vm.ts` — shrunk to core, installs helpers, runs user `setup.sh`
- `cli/commands/start.ts` — now resume-only; takes a required id, resolves via `resolveVmByPrefix`, calls shared mount/lockdown helpers in `lib/session.ts`, errors clearly on missing or running VMs
- `cli/avm.ts` — register both `create` and `start` subcommands
- `cli/commands/provision.ts` — drops legacy migration, adds `setup.sh` precondition
- `templates/vm-claude.md` — generic, no Alcova references, documents `avm create` vs `avm start`
- `README.md`, `CLAUDE.md`, `skills/avm/SKILL.md` — reflect new model and command split

**Deleted:**
- `lib/mirrors.ts` — its `ensureMirror` / `updateMirrors` functions existed only to support the `--clone` flow. Mirror lifecycle (`git clone --mirror`, `git fetch`) becomes the user's responsibility, guided by the `avm` host skill during onboarding.

**Unchanged:**
- `cli/commands/list.ts`, `cli/commands/attach.ts`, `cli/commands/stop.ts`, `cli/commands/clean.ts`
- `lib/vm.ts`
- `build.mjs`, `package.json` except adding `yaml` dep

**Added dep:** `yaml` (npm package) for config parsing.
