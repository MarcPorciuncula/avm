---
name: avm
description: Use when the user asks to spin up, attach to, list, or clean up alcova-vm sandbox VMs — the CLI for managing OrbStack-based Claude Code sandboxes.
---

# Using `avm`

`avm` is a CLI (installed globally via `pnpm link --global` from this repo)
that manages sandboxed agent VMs on OrbStack. Use it when the user wants
to work inside a disposable Linux VM with full Claude Code autonomy
(`--dangerously-skip-permissions`).

## When to use this skill

Invoke this skill when the user says things like:
- "give me a sandbox / VM / workspace"
- "spin up an avm"
- "start a fresh VM to work on X"
- "list my VMs" / "what sandboxes are running"
- "clean up that VM" / "tear it down"
- "attach to the sandbox"

## Commands

```
avm list                  # Show all avm-* VMs and their status
avm start [name]          # Create a new VM (random 5-char id if no name)
  --clone                 # Also reference-clone every known repo + symlink .env
  --attach                # Drop straight into the VM via SSH when setup finishes
avm attach [id]           # SSH into a VM; interactive picker if no id given
avm clean <id...>         # Stop and delete one or more VMs
  --all                   # Clean every avm-* VM
```

IDs are the 5-char suffix after `avm-` (e.g., `k7xf2`). Prefixes work as
long as they're unambiguous. `avm clean` with a prefix prompts for
confirmation before deleting; exact IDs don't.

## Typical Flows

### User wants a fresh sandbox to work on operator-ui

```
avm start --clone --attach
```

That's the complete answer. `--clone` pre-clones `operator-ui` and its
deps into `~/work/` and symlinks the `.env` file. `--attach` drops the
user straight into an SSH session.

### User wants a blank sandbox to experiment in

```
avm start --attach
```

No `--clone` — repos are not pre-cloned. The user (or Claude inside the
VM) can clone on demand from `~/mirrors/`.

### User wants to resume an existing sandbox

```
avm attach          # interactive picker
# or
avm attach <id>     # direct
```

### User wants to know what's running

```
avm list
```

### User is done with a sandbox

```
avm clean <id>
```

## What the flags actually do

- **`--clone`**: updates bare mirrors under `data/mirrors/`, then inside
  the VM reference-clones every repo in `REPO_DEPS` (see `lib/config.ts`)
  into `~/work/<repo>`, and symlinks `~/envs/<repo>.env` as the working
  copy's `.env`. This adds maybe 10-20 seconds to setup but leaves the
  user ready to `pnpm install && pnpm dev` immediately.
- **`--attach`**: after setup completes, `exec` into `ssh -t <vmName>@orb`
  so the user's terminal becomes the VM shell. Without this flag, `avm
  start` prints the SSH command and exits.

## Inside the VM

Once attached, the user (or Claude inside the VM) sees:

- `~/work/` — project repos (pre-cloned if `--clone` was used)
- `~/mirrors/` — bare mirrors for fast git clones
- `~/envs/` — `.env` files, flat naming (`operator-ui.env`)
- `~/.ssh/`, `~/.claude/`, `~/.claude.json`, `~/.gitconfig` — credentials
  and settings, all bind-mounted from the host
- `clauded` alias — runs Claude Code with `--dangerously-skip-permissions`

The host macOS filesystem is locked down after setup — `/mnt/mac` and
`/Users` are masked by empty bind-mounts. The agent can't escape.

## Things NOT to do

- **Don't create VMs by calling `orb` directly.** Always go through `avm
  start` so mounts, credentials, and lockdown are set up correctly.
- **Don't ask the user which repo or branch to use before starting a
  VM.** `avm start` intentionally doesn't take a branch. The user picks
  that inside the VM once they're there.
- **Don't auto-clean VMs.** Cleanup is the user's decision. The only
  cleanup command is `avm clean`.
- **Don't run the CLI from inside a VM.** `avm` is host-side only — it
  controls OrbStack from macOS. Inside a VM, the user just works with
  the repos directly.

## If something goes wrong

- **`avm start` fails because a VM already exists**: run `avm list` and
  either `avm clean` the old one or pass a different name.
- **SSH doesn't come up within 30s**: likely an OrbStack issue. The VM
  is left running for debugging. Check `orb list` and
  `orb logs <vmName>`.
- **Claude Code inside the VM runs onboarding every time**: the
  `data/claude.json` bind-mount may not be working. Check that
  `data/claude.json` exists on the host.
