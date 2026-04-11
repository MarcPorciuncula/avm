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
  up. Use `avm attach <id>` instead.
