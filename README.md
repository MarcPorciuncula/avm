# avm

A harness for running sandboxed Claude Code agents in Docker containers
with `--dangerously-skip-permissions`. Spin up a fresh, credential-loaded
workspace in seconds; tear it down when you're done.

## Why

Running Claude Code with `--dangerously-skip-permissions` on your host
machine is reckless — an unrestricted agent can read your credentials,
trash your filesystem, or do anything your user account can do.

`avm` gives agents full autonomy inside isolated Docker containers. The
agent thinks it has free rein. It does — inside a sandbox. The container
only sees explicitly mounted paths: credentials from `~/.avm/`, repo
clones, caches, and Claude Code settings. Nothing else from the host is
visible.

## Requirements

- macOS with [OrbStack](https://orbstack.dev/) installed (Docker
  provider — OrbStack's Docker runtime supports true `--network host`
  on macOS)
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
cp ~/.gitconfig ~/.avm/system/credentials/git/config
```

These are mounted into every container. Claude Code state
(`~/.avm/system/claude/` and `~/.avm/system/claude.json`) fills itself
in the first time you run `claude` inside a container — you can leave
those empty to start.

### 2. Create your Dockerfile

`~/.avm/Dockerfile` layers your toolchain on top of the `avm-core`
image — Go, Python, Docker CLI, language-specific tools, etc. It runs
during `avm provision` as a standard `docker build`.

Copy the provided example to get started:

```bash
cp examples/Dockerfile ~/.avm/Dockerfile
```

Then edit `~/.avm/Dockerfile` to match your stack. The example
reproduces a Go + Node + Docker environment; delete what you don't need.

If your Dockerfile needs to `COPY` files, place them in
`~/.avm/build-context/` — that directory is used as the Docker build
context.

### 3. Build the Docker images

```bash
avm provision
```

This builds two images: `avm-core:latest` (from
`dockerfiles/core.Dockerfile` in the repo) and `avm-user:latest` (from
your `~/.avm/Dockerfile`). Docker layer caching makes subsequent
rebuilds fast — only changed layers are rebuilt.

### 4. (Optional) Declare mounts and per-repo symlinks

Create `~/.avm/config.yaml` to declare bind mounts and per-repo
symlinks. The file is optional — without it, containers come up with
system mounts only.

```yaml
# ~/.avm/config.yaml

# Bind mounts applied to every session container on `avm create`.
# source is relative to ~/.avm/volumes/
# target is relative to /home/agent/ (or absolute if starting with /)
volumes:
  - pnpm-store:~/.local/share/pnpm/store
  - go-build:~/.cache/go-build
  - cargo:~/.cargo

# Per-repo config, applied by `avm-link` inside the container after the
# agent clones a repo. source is relative to ~/.avm/files/.
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
agent inside the container can then `git clone --reference
~/mirrors/<repo>.git ...` for near-instant clones.

### 6. Start your first session

```bash
avm create --attach
```

This creates a new container from the `avm-user` image, mounts
credentials and volumes, applies post-creation setup, and drops you into
the container.

## Commands

```
avm list                  # List all session containers
avm create [name]         # Create and start a new container
  --attach                # Attach to the container immediately (docker exec)
  --ssh                   # Attach via SSH instead of docker exec
avm start <id>            # Resume a stopped container
  --attach                # Attach to the container immediately (docker exec)
  --ssh                   # Attach via SSH instead of docker exec
avm attach [id]           # Attach to a running container (interactive picker if no id)
avm ssh <id>              # Connect to a container over SSH (starts sshd lazily)
  --print-command         # Print the SSH command instead of connecting
  --print-config          # Print an SSH config block for ~/.ssh/config
avm exec <id> <cmd...>    # Run a command inside a container (non-interactive)
  --root                  # Run as root instead of agent
avm stop <id...>          # Stop one or more containers without destroying them
  --all                   # Stop every running session container
avm clean <id...>         # Stop and delete one or more containers
  --all                   # Clean every session container
avm ssh-config            # Regenerate ~/.avm/ssh_config from current containers
avm ssh-config install    # Add Include line to ~/.ssh/config (enables `ssh avm-<id>`)
avm ssh-config uninstall  # Remove the Include line
avm provision             # Build or rebuild the Docker images
avm daemon start          # Start the host daemon (background)
avm daemon stop           # Stop the host daemon
avm daemon status         # Check if the daemon is running
avm service list          # List declared services and their status
avm service start <name>  # Start a host service
avm service stop <name>   # Stop a host service
avm service status <name> # Check a service's status
```

IDs are the 5-char suffix after `avm-`. You can pass a prefix — if it
matches exactly one container, it works; ambiguous prefixes print the
list of matches and exit. `avm clean` with a prefix prompts for
confirmation.

Inside every container, `clauded` is an alias for
`claude --dangerously-skip-permissions`, and `avm-link` applies the
per-repo symlinks declared in `~/.avm/config.yaml`.

Run `avm ssh-config install` (or accept the prompt on your first
`avm create`) to wire an `Include ~/.avm/ssh_config` line into your
`~/.ssh/config`. After that, `ssh avm-<id>` works from any terminal
without flags. Requires OpenSSH 7.3+ (2016), which any modern macOS
or Linux ships.

## Host Data Layout

Everything under `~/.avm/` is user-owned local state. Nothing in the
repo is touched by `avm` at runtime except `templates/` and `examples/`,
which ship as part of the CLI.

```
~/.avm/
├── config.yaml           # user-edited: volumes + per-repo config (optional)
├── Dockerfile            # user-written: layers toolchain on avm-core (required for `avm provision`)
├── build-context/        # Docker build context for ~/.avm/Dockerfile (COPY sources go here)
├── ssh_config            # managed by `avm ssh-config`; included from ~/.ssh/config when installed
├── state.json            # avm CLI preferences (e.g. remembered install-prompt decision)
├── daemon/               # managed by avm daemon
│   ├── host.secret       # host CLI auth (never mounted into containers)
│   ├── state.json        # daemon-internal state
│   ├── daemon.pid        # daemon PID
│   └── daemon.log        # daemon logs
├── system/               # fixed layout; mounted into every session container
│   ├── credentials/
│   │   ├── ssh/          # → ~/.ssh in container (bind mount)
│   │   └── git/
│   │       └── config     # → ~/.config/git/config in container (bind mount)
│   ├── claude/           # → ~/.claude in container (bind mount)
│   └── claude.json       # → ~/.claude.json in container (file bind mount)
├── mirrors/              # → ~/mirrors in container (bind mount)
├── volumes/              # bind sources declared in config.yaml
└── files/                # symlink sources for avm-link (→ ~/.avm-files in container)
```

## How `avm create` / `avm start` Work

Both commands share post-creation orchestration in `lib/session.ts`. The
difference is what happens first:

- **`avm create`** runs `docker run` with all mount arguments from
  `getDockerMountArgs`, creating and starting the container in one step.
- **`avm start`** runs `docker start` (the container already exists with
  its mounts baked in from creation).

Both then run `applyPostCreationSetup`:

1. Seed `~/.avm/system/claude/CLAUDE.md` from `templates/vm-claude.md`
   if missing (never overwrites).
2. Generate `/usr/local/bin/avm-link` from `config.yaml`.

Mounts are established at container creation time and persist across
`docker stop` / `docker start`. The container only sees explicitly
mounted paths — no lockdown step is needed.

## Cloning Repos From Inside the Container

`avm create` and `avm start` deliberately don't clone repos. That's the
agent's job, inside the container. The CLI's job is to make the tools
available: mirrors at `~/mirrors/`, overlay files at `~/.avm-files/`,
and `avm-link` on the PATH. The in-container `CLAUDE.md` (seeded from
`templates/vm-claude.md`) tells the agent how to use them.

## Customizing

### Adding a toolchain package

Edit `~/.avm/Dockerfile` and add the install command, then:

```bash
avm provision
```

This rebuilds the images. Docker layer caching means only changed layers
are rebuilt, so incremental changes are fast. Running containers are
unaffected — they use the image that existed at creation time.

Each `avm provision` creates a new `avm:<timestamp>` tag and re-points
`avm:latest`. Old tags accumulate over time. Opt into automatic cleanup
in `~/.avm/config.yaml`:

```yaml
prune_images:
  enabled: true
  keep_recent: 1
```

After each successful build, tags older than the most recent
`keep_recent` are removed. Tags still in use by a container are always
kept, regardless of `keep_recent`.

### Adding a per-repo config

Edit `~/.avm/config.yaml`:

```yaml
repos:
  my-new-service:
    symlinks:
      - envs/my-new-service.env:.env
```

Then drop `~/.avm/files/envs/my-new-service.env` in place. The next
`avm create` picks up the change. Existing containers get the update
on `avm start`.

### Customizing in-container Claude behavior

`~/.avm/system/claude/CLAUDE.md` is loaded automatically by Claude Code
inside every container. On first session creation it's seeded from
`templates/vm-claude.md`. Edit it freely afterwards — the seed is never
re-copied over an existing file.

## Host Services

Agents running inside containers can start and stop services on the host
machine via `avm-bridge`. This lets sandboxed agents control things like a
Chrome browser for testing, a local database, or any other host-side
process — without giving them direct host access.

### How it works

1. **Declare services** in `~/.avm/config.yaml`:

```yaml
services:
  chrome:
    kind: process
    command:
      - /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
      - --remote-debugging-port=9222
      - --user-data-dir=/tmp/chrome-devtools-profile
    check:
      tcp: 127.0.0.1:9222
```

2. **Start the daemon** on the host:

```bash
avm daemon start
```

3. **Use from inside a container** (the in-container agent runs these):

```bash
avm-bridge service start chrome    # start Chrome on the host
avm-bridge service status chrome   # check if it's running
avm-bridge service stop chrome     # stop it
```

Services can be `kind: process` (a host process managed directly) or
`kind: docker` (a Docker container started/stopped by the daemon). The
`check` block defines how the daemon verifies the service is ready —
currently `tcp` health checks are supported.

See `examples/config.yaml` for a full worked example.

### Editor integration

Agents inside containers can open files in the user's host editor:

```bash
avm-bridge editor open /home/agent/work/my-repo/src/foo.ts --line 42
```

This launches the editor (configured via `editor:` in `~/.avm/config.yaml`)
in remote-SSH mode, connected to the requesting container. Requires
`avm ssh-config install`.

## Architecture Notes

- **Daemon is the control plane.** The daemon tracks registered
  containers, host secrets, and service state. Use `avm` commands
  for all container operations.
- **Containers are flexible workspaces.** Use them semi-persistently
  for a thread of work, or ephemerally for a single task. Name them
  whatever fits the way you work. Cleanup is manual.
- **No automated tests.** This is a CLI glue layer. Verification is
  manual: run the commands, check that things work.

## Troubleshooting

- **`avm provision` fails with "Dockerfile not found"** — copy the
  example: `cp examples/Dockerfile ~/.avm/Dockerfile`, then edit it to
  fit your stack.
- **`avm provision` fails during image build** — fix the Dockerfile
  issue and rerun `avm provision`. Docker layer caching means only
  failed layers are rebuilt.
- **Login doesn't persist across containers** — make sure
  `~/.avm/system/claude.json` exists on the host. It's mounted as a
  file into every container; without it, Claude Code runs first-run
  setup every time. `avm create` creates an empty file if one isn't
  there.
- **`pnpm install` inside the container is slow every time** — declare a
  pnpm-store volume in `~/.avm/config.yaml`:
  `- pnpm-store:~/.local/share/pnpm/store`, and create
  `~/.avm/volumes/pnpm-store/`.
- **`git clone` inside the container is slow** — populate
  `~/.avm/mirrors/<repo>.git` with `git clone --mirror ...`, and have
  the agent use `git clone --reference ~/mirrors/<repo>.git ...`.
- **`avm create` fails with "container already exists"** — that name is
  taken. Use `avm list` to see what's running; `avm start <id>` to
  resume, or `avm clean <id>` to free it up.
- **`avm start <id>` fails with "already running"** — the container is
  already up. Use `avm attach <id>` instead.
