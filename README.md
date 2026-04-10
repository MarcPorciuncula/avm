# alcova-vm

A harness for running sandboxed Claude Code agents in OrbStack Linux VMs
with `--dangerously-skip-permissions`. Spin up a fresh, credential-loaded
workspace in a couple of seconds; tear it down when you're done.

## Why

Running Claude Code with `--dangerously-skip-permissions` on your host
machine is reckless — an unrestricted agent can read your credentials,
trash your filesystem, or do anything your user account can do.

alcova-vm gives agents full autonomy inside disposable, locked-down
OrbStack VMs. The agent thinks it has free rein. It does — inside a
sandbox. The host filesystem is bind-mount-masked after setup, credentials
are bind-mounted from a gitignored `data/` directory, and repo clones,
pnpm store, and Claude Code settings are shared from the host so you don't
lose state when a VM is destroyed.

## Requirements

- macOS with [OrbStack](https://orbstack.dev/) installed
- Node 24+ (the CLI itself runs on the host via tsx)
- pnpm (via corepack or standalone)
- A GitHub SSH key and git identity

## Install

```bash
git clone git@github.com:Alcova-AI/alcova-vm.git
cd alcova-vm
pnpm install
pnpm link --global
```

`pnpm install` runs a `prepare` script that bundles the CLI to
`dist/avm.mjs` via esbuild. `pnpm link --global` then symlinks `avm` into
your shell PATH. Run `avm --help` to confirm.

After pulling new changes, run `pnpm install` again (or `pnpm run build`)
to rebuild `dist/avm.mjs`. For iterative development, use
`pnpm run dev <command>` to run the CLI via `tsx` without a rebuild.

### (Optional) Install the Claude Code skill

This repo ships a skill at `skills/avm/` that teaches your host-side Claude
Code when and how to invoke `avm`. Symlink it into your user-level skills
directory so any Claude Code session on the host can use it:

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/avm" ~/.claude/skills/avm
```

The symlink keeps the skill in sync with `git pull` — updates here
propagate immediately. To uninstall, delete the symlink.

## First-Time Setup

### 1. Seed host credentials

Put your SSH keys, git config, and any per-project `.env` files under
`data/`:

```
data/
├── credentials/
│   ├── ssh/
│   │   ├── id_ed25519        # your GitHub SSH key
│   │   ├── id_ed25519.pub
│   │   └── config            # ssh client config (e.g. github.com host entry)
│   └── git/
│       └── .gitconfig        # your git identity
└── envs/
    └── operator-ui.env       # per-project dotenv files (one per repo)
```

These are bind-mounted into every VM. A fresh clone of this repo starts
with an empty `data/` that fills up as you use it.

### 2. Provision the base VM

The base VM (`avm-base`) is a template — a stopped Ubuntu VM with the
full toolchain pre-installed. Every agent session clones it.

```bash
avm provision
```

This takes several minutes. If `avm-base` already exists and is stopped,
it's deleted and rebuilt from scratch. If it's running (e.g., you were
experimenting in it interactively), the command errors out — stop it
first with `orb stop avm-base`.

It installs:

- Node 24, pnpm (via corepack), Python 3
- Go (latest stable), with `GOPRIVATE=github.com/Alcova-AI/*` preset
- Buf CLI, Atlas CLI, Task (taskfile.dev), golangci-lint, staticcheck
- Docker + Docker Compose
- Claude Code
- Git URL rewriting so private Go modules fetch via SSH

`lib/base-vm.ts` is the source of truth for what's in the base VM — if
you need a new tool, add it there and run `avm provision` again to
rebuild.

### 3. Start your first session

```bash
avm start --clone --attach
```

This clones the base VM, sets up mounts, reference-clones every repo in
`REPO_DEPS` (from `lib/config.ts`), symlinks matching `.env` files, and
drops you into an SSH shell. Inside the VM: `cd ~/work/operator-ui && pnpm
install && pnpm dev`.

## Commands

```
avm list                  # List all session VMs
avm start [name]          # Create and start a new agent VM
  --clone                 # Also clone all known repos + symlink .env files
  --attach                # Drop straight into the VM via SSH
avm attach [id]           # SSH into a VM (interactive picker if no id)
avm stop <id...>          # Stop one or more VMs without destroying them
  --all                   # Stop every running session VM
avm clean <id...>         # Stop and delete one or more VMs
  --all                   # Clean every session VM
avm provision             # Create or rebuild the avm-base template
```

IDs are the 5-char suffix after `avm-`. You can pass a prefix — if it
matches exactly one VM, it works; if ambiguous, you get the list of
matches. `avm clean` with a prefix (rather than a full ID) prompts for
confirmation before deleting.

Inside every VM, `clauded` is an alias for `claude --dangerously-skip-permissions`.

## Host Data Layout

Everything under `data/` is gitignored. It's local state that accumulates
as you use the repo — never commit it.

```
data/
├── credentials/ssh/          → ~/.ssh         (bind-mounted)
├── credentials/git/.gitconfig → ~/.gitconfig  (copied)
├── envs/<repo>.env            → ~/envs/<repo>.env (bind-mounted)
├── mirrors/<repo>.git/        → ~/mirrors/<repo>.git (bind-mounted)
├── cache/shared/pnpm-store/   → ~/.local/share/pnpm/store (bind-mounted)
├── claude/                    → ~/.claude     (bind-mounted)
└── claude.json                → ~/.claude.json (bind-mounted file)
```

- **credentials/** — SSH keys and git identity. Mounted into every VM so
  `git push` and `ssh git@github.com` just work.
- **envs/** — Flat per-repo `.env` files. `avm start --clone` symlinks
  them into each repo's working copy; otherwise Claude can symlink on
  demand from inside the VM.
- **mirrors/** — Bare repo mirrors fetched from GitHub. VMs
  reference-clone through these so fresh clones take milliseconds and
  reuse existing objects. Updated automatically when you run `avm start
  --clone`.
- **cache/shared/pnpm-store/** — Shared pnpm content-addressed store.
  `pnpm install` across VMs is near-instant after the first run.
- **claude/** and **claude.json** — Your Claude Code home directory and
  settings. Shared across VMs so login and session state persist.

## How avm start Works

Rough order of operations:

1. Generate `avm-<5-char-suffix>` (or use the provided name).
2. If `--clone`, `git fetch --all --prune` on each mirror in `REPO_DEPS`.
3. `orb clone alcova-base <name>` (copy-on-write, takes ~1s).
4. `orb start <name>`, poll SSH until it's up.
5. Bind-mount credentials, `~/envs`, `~/mirrors`, `~/.claude`,
   `~/.claude.json`, and the pnpm store inside the VM.
6. Copy `.gitconfig` to `/home/agent/.gitconfig`.
7. Seed `data/claude/CLAUDE.md` from `templates/vm-claude.md` if missing.
8. If `--clone`, reference-clone every repo in `REPO_DEPS` into
   `~/work/<repo>` and symlink its env file.
9. Lock down the host mount: bind-mount empty directories over `/mnt/mac`
   and `/Users` so the agent user can't traverse back to the host
   filesystem. (VirtioFS doesn't support `chmod`, so this mask is the
   only reliable way.)
10. Print the SSH command (or `exec` into it if `--attach`).

All bind-mounts — including the ones under `credentials/` — are
established *before* the lockdown, and the lockdown only masks `/mnt/mac`
and `/Users`, so the mounted content at `/home/agent/...` remains fully
accessible. The agent can't escape to the host, but it can still read its
SSH keys and write to the shared caches.

## Customizing

### Adding a repo

Edit `lib/config.ts`:

```typescript
export const REPO_DEPS: Record<string, string[]> = {
  "operator-ui": ["alcova-backend"],
  "my-new-service": [],  // no dependencies
};
```

Then drop `data/envs/my-new-service.env` if it needs one. The next
`avm start --clone` will pick it up.

### Adding a toolchain package

Edit `lib/base-vm.ts` and add the install command. Then:

```bash
avm provision
```

This wipes and rebuilds `avm-base`. Any running agent VMs are unaffected
(they're already OrbStack copy-on-write clones and don't share state with
the template after creation).

### Customizing in-VM behavior

`data/claude/CLAUDE.md` is loaded automatically by Claude Code inside
every VM. On first `avm start` it's seeded from `templates/vm-claude.md`
in this repo, and you can edit it afterwards — the template is never
re-copied over an existing file.

## Architecture Notes

- **No state service.** `orb list -f json` is the source of truth. The
  CLI is a thin wrapper over `orb` and SSH.
- **VMs are reusable workspaces, not per-PR containers.** Name them
  whatever fits the way you work. Cleanup is manual.
- **No automated tests.** This is a CLI glue layer. Verification is
  manual: run the commands, check that things work.

## Troubleshooting

- **Login doesn't persist across VMs** — make sure `data/claude.json`
  exists on the host. It's bind-mounted into every VM; without it,
  Claude Code runs first-run setup every time. `avm start` creates an
  empty file if one isn't there.
- **`pnpm install` inside the VM is slow every time** — check that
  `data/cache/shared/pnpm-store/` exists and that the mount inside the
  VM at `~/.local/share/pnpm/store` has contents.
- **`git clone` inside the VM is slow** — the mirror at
  `~/mirrors/<repo>.git` may be missing or stale. Run `avm start --clone`
  to refresh mirrors.
- **`avm start` fails with "VM already exists"** — that name is taken.
  Use `avm list` to see what's running and `avm clean <id>` if you want
  to free it up.
