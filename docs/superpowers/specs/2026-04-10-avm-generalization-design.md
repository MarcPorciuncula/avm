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
├── system/               # CLI-managed; users don't edit directly
│   ├── credentials/
│   │   ├── ssh/          # GitHub SSH keys + ssh config
│   │   └── git/
│   │       └── .gitconfig
│   ├── claude/           # Claude Code home (~/.claude in VM)
│   ├── claude.json       # Claude Code settings
│   └── mirrors/          # bare git mirrors for --clone
├── volumes/              # bind-mount sources (one subdir per declared volume)
│   ├── pnpm-store/
│   ├── go-build/
│   └── cargo/
└── files/                # symlink sources (and future copy sources)
    ├── envs/
    │   └── operator-ui.env
    └── configs/
        └── alcova-backend/local.yml
```

**Separation rationale:**

- `system/` is load-bearing for the CLI itself (SSH is how credentials reach the VM, `mirrors/` is how `--clone` works). The CLI owns these paths. Users populate them (`ssh/id_ed25519`, `.gitconfig`, initial `git clone --mirror` to populate a mirror) but don't move or rename them.
- `volumes/` holds content that becomes a bind mount inside the VM. Each subdirectory is the source for exactly one declared volume.
- `files/` holds content that becomes a symlink inside a cloned repo. The entire `files/` directory is mounted once into the VM at a fixed path so symlinks have a real target to point at.

The split means that inside the VM, user-declared volumes resolve to proper bind mounts (tools see normal directories), while symlink sources all resolve through a single mount of `files/`. No double-mounting.

## Config File

Path: `~/.avm/config.yaml`. Format: YAML, docker-compose-inspired.

```yaml
# ~/.avm/config.yaml

# Bind mounts applied to every VM session on `avm start`.
# source is relative to ~/.avm/volumes/
# target is relative to /home/agent/ (or absolute if starting with /)
volumes:
  - pnpm-store:~/.local/share/pnpm/store
  - go-build:~/.cache/go-build
  - go-mod:~/go/pkg/mod
  - cargo:~/.cargo

# Per-repo config. Applied during `avm start --clone` and via `avm-link`
# inside the VM when cloning on demand.
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
- `<name>` in `repos:` is the lookup key used by `avm-link`. For `--clone`, `<name>` must match a mirror basename at `~/.avm/system/mirrors/<name>.git`. For on-demand clones, `<name>` is whatever the user passes as the first arg to `avm-link` (defaults to `$(basename "$PWD")`).
- File vs. directory is auto-detected by stat'ing the source.
- A missing source is a warning, not an error. This lets a single `config.yaml` work across VMs where some caches haven't been populated yet, and across repos where not every repo has every config file.
- A `repos:` entry without a corresponding mirror is valid — it just means `--clone` won't create that repo, but `avm-link <name>` still works for manually-cloned copies.

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

## `avm start` Changes

### Before Any Cloning

1. Read `~/.avm/config.yaml` (tolerate absence: treat as empty `volumes` and empty `repos`).
2. `orb clone avm-base <session>`, `orb start <session>`, wait for SSH.
3. Apply **system mounts** (hardcoded, always on):
   - `~/.avm/system/credentials/ssh/` → `/home/agent/.ssh`
   - `~/.avm/system/claude/` → `/home/agent/.claude`
   - `~/.avm/system/claude.json` → `/home/agent/.claude.json` (file bind mount)
   - `~/.avm/system/mirrors/` → `/home/agent/mirrors`
   - Copy `~/.avm/system/credentials/git/.gitconfig` → `/home/agent/.gitconfig` (plain copy, not a mount)
4. Apply **`files/` holding mount**:
   - `~/.avm/files/` → `/home/agent/.avm-files/`
5. Apply **user volumes** (from `config.yaml`):
   - For each `volumes[]` entry, `mount --bind ~/.avm/volumes/<source>/ <target>` (resolving `<target>` relative to `/home/agent/` unless absolute).
   - Warn (don't fail) if the source path doesn't exist.
6. **Write generated `/usr/local/bin/avm-link`** (see next section).
7. Seed `~/.avm/system/claude/CLAUDE.md` from the repo's `templates/vm-claude.md` if missing. Once seeded, the user edits it freely; the CLI never overwrites an existing file.

### If `--clone`

8. Enumerate `~/.avm/system/mirrors/` — every `*.git` bare repo is a candidate.
9. For each mirror:
   - `git -C <mirror> fetch --all --prune` (refresh on the host, pre-clone).
   - Inside the VM: `git clone --reference ~/mirrors/<name>.git $(git -C ~/mirrors/<name>.git remote get-url origin) ~/work/<name>`.
   - Inside the VM: `cd ~/work/<name> && avm-link` to apply any configured symlinks.

The origin URL is read from the mirror itself at clone time — no `GITHUB_ORG` or `REPO_DEPS` needed. Mirrors from multiple orgs just work.

### Lockdown

10. Bind-mount empty directories over `/mnt/mac` and `/Users` (unchanged from today).
11. Print the SSH command. If `--attach`, exec into SSH.

## Generated `avm-link`

At `avm start`, the CLI reads `config.yaml` and generates a bash script at `/usr/local/bin/avm-link` inside the VM. Written as root before lockdown.

Example output for the example config above:

```bash
#!/bin/bash
# Generated by avm start — do not edit
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
- The CLI's own `--clone` path invokes this helper after each clone — one code path for applying symlinks.

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
- `avmSystemMirrorsDir = path.join(avmSystemDir, "mirrors")`
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

### `cli/commands/start.ts`

Rewrite the mount setup block to use the new paths. Remove the clone loop that uses `ALL_REPOS`, `REPO_DEPS`, and `GITHUB_ORG`. Replace with:
- Enumerate `~/.avm/system/mirrors/*.git`
- For each: fetch on host, clone inside VM using origin URL from the mirror, run `avm-link` inside the VM
- Skip cloning entirely if `~/.avm/system/mirrors/` is empty or `--clone` is not set

Add the config-reading and `avm-link` generation block.

### `templates/vm-claude.md`

Rewrite as a generic in-VM CLAUDE.md seed:
- Describes the standard paths (`~/work/`, `~/mirrors/`, `~/.avm-files/`)
- Describes `avm-link` usage
- Describes `clauded` alias
- No Alcova repo references
- No Go/Atlas/Task/GOPRIVATE sections

### `README.md`, `CLAUDE.md`, `skills/avm/SKILL.md`

Strip Alcova-specific language throughout. Document:
- The new `~/.avm/` layout
- Config file format and resolution rules
- `setup.sh` and `/opt/avm/helpers.sh`
- `avm-link` usage
- No auto-migration from old layout — users start fresh

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
5. `avm start` — start a session

The README's "First-Time Setup" section walks through these five steps in order. We do not auto-scaffold `~/.avm/` — the user creates the directories themselves (or via `cp -r` from the repo's examples). Scaffolding would be code to debug for a one-time operation.

Optional after step 3, for `--clone` to be useful:
- Populate `~/.avm/system/mirrors/` with bare clones of frequently-used repos.
- Populate `~/.avm/files/envs/<repo>.env` and/or `~/.avm/files/configs/<repo>/*` with per-repo overlays.
- Populate `~/.avm/volumes/<name>/` with empty directories for caches (they fill as you use them).
- Create `~/.avm/config.yaml` declaring the volumes and repo symlinks.

## Component Boundaries

| Component | Owner | Lives In | Changes Here? |
|---|---|---|---|
| CLI entrypoint + command wiring | CLI | `cli/avm.ts`, `cli/commands/*` | Mount setup, provision, start |
| Host path constants | CLI | `lib/config.ts` | Rewritten — see removals |
| Base VM core provisioner | CLI | `lib/base-vm.ts` | Shrunk to minimal core |
| Base VM user provisioner | User | `~/.avm/setup.sh` | New — runs after core |
| Config parsing + validation | CLI | `lib/config-file.ts` (new) | New — reads `~/.avm/config.yaml` |
| Mount orchestration | CLI | `cli/commands/start.ts` | Rewritten to use new config |
| `avm-link` generator | CLI | `cli/commands/start.ts` (or helper in `lib/`) | New |
| Mirrors helpers | CLI | `lib/mirrors.ts` | Path updates only |
| VM helpers library | CLI (installed into VM) | `templates/vm-helpers.sh` (new) | New |
| In-VM CLAUDE.md seed | CLI | `templates/vm-claude.md` | Rewritten generic |
| Example setup script | CLI (ships as example) | `examples/setup.sh` | New |

New file: `lib/config-file.ts`. Responsibilities:
- Read `~/.avm/config.yaml`
- Parse YAML via the `yaml` package
- Validate schema (strict; unknown keys error)
- Return a typed `AvmConfig` object
- Export a `generateAvmLinkScript(config): string` function used by start.ts

Keeping this in its own file keeps `start.ts` focused on orchestration and makes the config logic independently understandable.

## Risks and Open Questions

- **Strict validation + typos in config.yaml.** A typo in `volumes` vs `volume` must produce a clear error pointing at the line number. YAML parsers generally expose this; verify the `yaml` package does when we implement.
- **Generated `avm-link` is per-VM, not shared state.** Editing `~/.avm/config.yaml` after starting a session does not update running VMs. `avm start` on a new session picks up the latest. Document this clearly so users don't wonder why their edit isn't taking effect.
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
- `examples/setup.sh` — working example user script (bash translation of current `lib/base-vm.ts` Alcova content)
- `templates/vm-helpers.sh` — VM-side `as_agent`/`echo_step` shell helpers (installed at `/opt/avm/helpers.sh` in VMs)
- `lib/config-file.ts` — YAML parsing, validation, `avm-link` generation

**Rewritten:**
- `lib/config.ts` — paths point at `~/.avm/`, Alcova constants deleted
- `lib/base-vm.ts` — shrunk to core, installs helpers, runs user `setup.sh`
- `cli/commands/start.ts` — reads config, applies new mounts, generates `avm-link`, uses mirror origin URLs
- `cli/commands/provision.ts` — drops legacy migration, adds `setup.sh` precondition
- `templates/vm-claude.md` — generic, no Alcova references
- `README.md`, `CLAUDE.md`, `skills/avm/SKILL.md` — reflect new model

**Unchanged:**
- `cli/commands/list.ts`, `cli/commands/attach.ts`, `cli/commands/stop.ts`, `cli/commands/clean.ts`
- `lib/vm.ts`
- `lib/mirrors.ts` (only path constant imports update)
- `build.mjs`, `package.json` except adding `yaml` dep

**Added dep:** `yaml` (npm package) for config parsing.
