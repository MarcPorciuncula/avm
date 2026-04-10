# `avm` CLI Design

## Goal

Replace the ad-hoc `setup/session-setup.ts` script with a small CLI (`avm`) that
makes spinning up and managing agent VMs as low-friction as possible. The
target workflow is: one command to get a fresh sandboxed VM, jump in, let
Claude take over.

## Principles

- **Defer decisions.** `avm start` should not require a repo or branch upfront.
  Those decisions happen inside the VM, via Claude, once you're there.
- **Lean on OrbStack for state.** No separate state service. `orb list` is the
  source of truth for what VMs exist. Anything richer (branches, dev servers,
  in-progress work) is out of scope for this iteration.
- **VMs are reusable workspaces, not disposable per-PR containers.** Cleanup is
  manual — the user decides when a VM is done.
- **Thin wrapper.** The CLI orchestrates `orb`, SSH, and mounts. Everything
  else (checking out branches, installing deps, starting servers) is Claude's
  job once inside the VM.

## Commands

### `avm list`

Lists all VMs whose names start with `avm-`. Excludes `alcova-base` and any
manually created VMs.

**Output columns:**
- ID — the 5-char suffix after `avm-`
- Name — full VM name
- Status — running / stopped

**Implementation:** shell out to `orb list`, filter lines beginning with `avm-`,
parse into table rows.

**Errors:**
- If `orb` is not installed or not in `PATH`, print a clear error and exit
  non-zero.

### `avm start [name]`

Creates a new agent VM, sets up mounts and credentials, and prints (or execs
into) an SSH command.

**Positional args:**
- `name` (optional) — the suffix after `avm-`. The CLI always prepends `avm-`
  to produce the real VM name (e.g., `avm start foo` → `avm-foo`). If omitted,
  generate a 5-char random lowercase alphanumeric suffix (e.g., `avm-k7xf2`).
  If the user passes a name already starting with `avm-`, strip the prefix
  before prepending to avoid `avm-avm-foo`.

**Flags:**
- `--clone` — eagerly reference-clone every repo in `REPO_DEPS` into
  `~/work/<repo>` and copy `.env` files. Without this flag, the VM starts
  empty and Claude clones on demand using the mounted mirrors.
- `--attach` — after setup, `exec` into `ssh <name>@orb` so the user's
  terminal becomes the VM shell. Without this flag, print the SSH command and
  exit.

**Flow:**

1. Parse args and generate name if needed.
2. Ensure host-side `data/` directories exist (credentials, mirrors, cache,
   claude).
3. If `--clone`: run `git fetch --all --prune` on each mirror in `REPO_DEPS`
   (and create missing mirrors via `git clone --bare`).
4. `orb clone alcova-base <name>` then `orb start <name>`.
5. Wait for SSH (polling up to 30s).
6. Bind-mount as root inside the VM:
   - `<host>/data/credentials/ssh` → `/home/agent/.ssh`
   - `<host>/data/claude` → `/home/agent/.claude`
   - `<host>/data/cache/shared/pnpm-store` → `/home/agent/.local/share/pnpm/store`
   - `<host>/data/mirrors` → `/home/agent/mirrors`
   - `chown -R agent:agent` on the mount points
7. Copy `<host>/data/credentials/git/.gitconfig` → `/home/agent/.gitconfig`.
8. If `--clone`: for each repo in `REPO_DEPS`:
   - As `agent`: `git clone --reference /home/agent/mirrors/<repo>.git
     git@github.com:Alcova-AI/<repo>.git /home/agent/work/<repo>` (note: no
     `--dissociate` — the clone keeps a link to the mirror to save disk space
     and accelerate future fetches).
   - If `<host>/data/credentials/<repo>/.env` exists, copy it to
     `/home/agent/work/<repo>/.env`.
9. Lock down host mount as root: bind-mount empty directories over `/mnt/mac`
   and `/Users` to hide the host filesystem from the agent user (VirtioFS
   doesn't support `chmod`).
10. Print `ssh <name>@orb`.
11. If `--attach`: `exec` into `ssh <name>@orb`.

**Errors:**
- If a VM with the target name already exists, error out before touching
  anything.
- If SSH doesn't come up within 30s, print an error. Leave the VM running so
  the user can debug (don't auto-delete).

### `avm clean <id...>`

Stops and deletes one or more VMs.

**Args:**
- `id...` — one or more short IDs (the 5-char suffix). Each is expanded to
  `avm-<id>` before operating.

**Flags:**
- `--all` — ignore positional args and clean every VM matching `avm-*`.

**Flow:**

For each resolved VM name:
1. `orb stop <name>` (allow failure — it may already be stopped).
2. `orb delete -f <name>`.

**Errors:**
- If a VM doesn't exist, print a warning and continue with the next ID rather
  than aborting.
- Without `--all` and with no positional args, error out with usage.

## Project Structure

```
alcova-vm/
├── cli/
│   ├── avm.ts                 # citty entrypoint, registers subcommands
│   └── commands/
│       ├── list.ts
│       ├── start.ts
│       └── clean.ts
├── lib/
│   ├── vm.ts                  # SSH runners, waitForSsh, name generation, orb wrappers
│   ├── config.ts              # GITHUB_ORG, REPO_DEPS, path constants, vmHostPrefix helper
│   └── mirrors.ts             # ensureMirror, updateMirrors
├── setup/
│   └── base-vm-provision.ts   # refactored to import from lib/vm.ts
├── data/                      # gitignored, host-side state
│   ├── credentials/
│   ├── mirrors/
│   ├── cache/
│   └── claude/
│       └── CLAUDE.md          # in-VM agent instructions (see below)
└── package.json
```

**Removed:**
- `setup/session-setup.ts` — subsumed by `avm start --clone`.

**package.json changes:**
- Add `citty` dependency.
- Add `"avm": "tsx cli/avm.ts"` script (or equivalent bin entry).
- Drop the `session` script.

## Shared Helpers (`lib/vm.ts`)

Extracted from the existing scripts:

- `asRoot(vmName: string, cmd: string): Promise<void>` — pipes `cmd` via stdin
  to `ssh root@<vmName>@orb bash -l`.
- `asAgent(vmName: string, cmd: string): Promise<void>` — same, but as the
  default `agent` user.
- `waitForSsh(vmName: string, timeoutSeconds?: number): Promise<void>` — polls
  SSH connectivity, throws on timeout.
- `generateSessionName(): string` — returns `avm-<5 random lowercase
  alphanumeric chars>`.
- `listAvmVms(): Promise<VmInfo[]>` — runs `orb list`, filters to `avm-*`,
  parses into `{ id, name, status }`.
- `vmHostPrefix(): string` — returns `/mnt/mac<REPO_ROOT>`, the VM-side path to
  the alcova-vm repo on the host.

## In-VM CLAUDE.md

Lives at `data/claude/CLAUDE.md` on the host and is automatically available as
`~/.claude/CLAUDE.md` inside every VM via the existing `data/claude/` →
`~/.claude/` bind-mount.

**Contents to include:**

- **Environment overview.** You are running inside an alcova-vm sandbox. The
  host filesystem is locked down. You have full permission to act autonomously
  within the VM.
- **Available toolchain.** Node 24, pnpm (via corepack), Python 3, buf,
  standard build tools. Use `clauded` as a shortcut for
  `claude --dangerously-skip-permissions` inside the VM.
- **Repo paths.** Repos live under `~/work/<repo>`. If `--clone` was used,
  they're already present. Otherwise clone from the mirrors.
- **Cloning from mirrors.** Local bare mirrors of known repos are mounted at
  `~/mirrors/<repo>.git`. To clone:
  ```
  git clone --reference ~/mirrors/<repo>.git \
    git@github.com:Alcova-AI/<repo>.git \
    ~/work/<repo>
  ```
  Do not use `--dissociate`; the linked mirror saves disk space and speeds up
  future fetches. The mirror is read-only from the VM's perspective — don't
  run `git gc` expecting it to affect the mirror.
- **Known repos and dependencies.** List each primary repo and its deps (e.g.,
  `operator-ui` depends on `alcova-backend` being cloned alongside it).
- **Dev server guidance.** `operator-ui` dev server runs on port 3000 via
  `pnpm dev`. OrbStack auto-forwards ports to the host.
- **Git workflow.** SSH credentials are mounted from the host. Commits use
  `marc@alcova.ai` via the mounted `.gitconfig`. Push to remote normally.
- **What's mounted, what's not.** `~/.ssh`, `~/.claude`, `~/.gitconfig`,
  `~/mirrors`, the shared pnpm store are all bind-mounts from the host and
  persist across VM sessions. Everything else is ephemeral to this VM.

The exact text of `CLAUDE.md` will be written during implementation; the above
is the required coverage.

## Mirrors as Mounted Dependencies

The existing `session-setup.ts` updates mirrors on the host and then relies on
the `/mnt/mac/...` path to reach them during cloning. After the host mount
lockdown, that path disappears.

This design adds a dedicated bind-mount: `data/mirrors/` → `/home/agent/mirrors/`
inside the VM. That mount survives the host lockdown because it's a separate
mount target, not a subpath of `/mnt/mac`. Claude can reference-clone from
`~/mirrors/` at any time during the session.

Clones use `--reference` without `--dissociate`: the cloned repo stores a link
to the mirror's object database. This saves hundreds of MB per clone and makes
subsequent fetches reuse existing objects. The risk — a mirror `git gc`
pruning objects a clone depends on — is low because the mirrors are
fetch-only and we never run `gc` on them.

## Testing

No automated tests. The CLI is a thin wrapper over `orb` and SSH; the valuable
verification is manual end-to-end:

1. `avm start --clone --attach` → lands in a VM shell.
2. Verify mounts: `~/.ssh`, `~/.claude`, `~/mirrors`, `~/work/operator-ui`.
3. `cd ~/work/operator-ui && pnpm install && pnpm dev` — dev server
   accessible from host on `http://localhost:3000`.
4. Exit, run `avm list` → sees the VM.
5. `avm clean <id>` → VM gone.

## Open Questions

None — all design decisions confirmed during brainstorming.
