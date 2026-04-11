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
