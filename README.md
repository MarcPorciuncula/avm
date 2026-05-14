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

## First-Time Setup (Claude Code defaults)

`avm` keeps all user-owned state under `~/.avm/`. A fresh install starts
with no `~/.avm/` at all — you create the pieces you need. The
walkthrough below reproduces avm's Claude-flavored defaults: Claude Code
in the image, credentials and Claude state mounted in, AGENTS.md
presented as CLAUDE.md, host notifications and desktop dropdown wired
up. To use a different agent harness, see
["Using a different agent harness"](#using-a-different-agent-harness)
below.

On a fresh machine you can walk through the steps manually, or let the
host-side Claude skill guide you.

### 1. Seed credentials and Claude state

```bash
mkdir -p ~/.avm/volumes/ssh ~/.avm/volumes/git ~/.avm/volumes/claude
touch ~/.avm/volumes/claude.json

cp ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub ~/.ssh/config ~/.avm/volumes/ssh/
cp ~/.gitconfig ~/.avm/volumes/git/config
```

These directories back the bind mounts declared in the Claude-defaults
`config.yaml` below. Claude Code state (`~/.avm/volumes/claude/` and
`~/.avm/volumes/claude.json`) fills itself the first time you run
`claude` inside a container — leave them empty to start.

### 2. Drop in the Claude defaults

```bash
cp <avm-repo>/examples/Dockerfile  ~/.avm/Dockerfile
cp <avm-repo>/examples/config.yaml ~/.avm/config.yaml
```

`examples/Dockerfile` ships a reference toolchain (pnpm, Python, Go,
Buf, Atlas, Task, etc.) with a clearly-labelled Claude Code block at
the bottom. `examples/config.yaml` wires up the matching mounts
(`ssh`, `git`, `claude`, `claude.json`), points `agents_md` at
`~/CLAUDE.md`, `skills_dir` at `~/.claude/skills`, and enables the
Claude desktop and notifications integrations. Edit both files to
match your stack and which integrations you want.

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

### 4. Start your first session

```bash
avm create --attach
```

This creates a new container from the `avm-user` image, mounts
credentials and volumes, applies post-creation setup, and drops you into
the container.

### 5. (Optional) Populate mirrors and per-repo overlays

For faster clones of large repos, create bare mirrors:

```bash
git clone --mirror git@github.com:<owner>/<repo>.git ~/.avm/mirrors/<repo>.git
```

Refresh with `git -C ~/.avm/mirrors/<repo>.git fetch --all --prune`. The
agent inside the container can then run `avm-bridge clone <repo>` (which
resolves the mirror automatically) for near-instant clones.

To inject env files or config overrides into specific repos as they're
cloned, declare them under `repos:` in `~/.avm/config.yaml` and drop the
source files under `~/.avm/files/`:

```yaml
repos:
  my-service:
    symlinks:
      - envs/my-service.env:.env
      - configs/my-service/local.yml:config/local.yml
```

```bash
mkdir -p ~/.avm/files/envs ~/.avm/files/configs/my-service
# ... drop your .env / config files into ~/.avm/files/
```

The next `avm-bridge clone <repo>` (or `avm-bridge link` from inside a
working copy) applies the symlinks.

## Using a different agent harness

avm's core image installs no specific agent — that's a Dockerfile
decision. To swap Claude for another harness:

- Strip or replace the "Claude Code" block in `~/.avm/Dockerfile` with
  your harness's install commands.
- In `~/.avm/config.yaml`, remove the `claude:~/.claude` and
  `claude.json:~/.claude.json` volumes (or replace with your harness's
  state paths).
- Set `skills_dir` to your harness's skills directory (or remove the
  key to skip the symlink step).
- Adjust `agents_md` if your harness reads `AGENTS.md` (the default)
  vs. a different file name. Use a list to mount it at multiple paths.
- Disable `integrations.claude_notifications` and
  `integrations.claude_desktop` unless you're keeping Claude alongside.

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
avm editor <id>           # Open a container in the configured editor (code, cursor, or zed)
avm stop <id...>          # Stop one or more containers without destroying them
  --all                   # Stop every running session container
avm clean <id...>         # Stop and delete one or more containers
  --all                   # Clean every session container
avm ssh-config            # Regenerate ~/.avm/ssh_config (and ~/.claude/settings.json if installed)
avm ssh-config install    # Add Include to ~/.ssh/config and (optionally) register avm in Claude desktop
  --desktop               # Skip the prompt; install desktop registration
  --no-desktop            # Skip the prompt; don't install desktop registration
avm ssh-config uninstall  # Remove the Include and any avm entries from ~/.claude/settings.json
avm provision             # Build or rebuild the Docker images
avm daemon start          # Start the host daemon (background; auto-started as needed)
avm daemon stop           # Stop the host daemon
avm daemon restart        # Stop and start the host daemon
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
`claude --dangerously-skip-permissions`, and `avm-bridge link` applies
the per-repo symlinks declared in `~/.avm/config.yaml` (run from inside
a working copy under `~/work/`).

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
├── config.yaml           # user-edited: agents_md, skills_dir, integrations, volumes, repos, services
├── state.json            # avm CLI preferences (currently: SSH-config Include install prompt)
├── Dockerfile            # user-written: layers toolchain on avm-core (required for `avm provision`)
├── build-context/        # Docker build context for ~/.avm/Dockerfile (COPY sources go here)
├── AGENTS.md             # generated every command from templates/agents.md; mounted into each container per `agents_md`
├── ssh_config            # managed by `avm ssh-config`; included from ~/.ssh/config when installed
├── daemon/               # managed by avm daemon
│   ├── host.secret       # host CLI auth (never mounted into containers)
│   ├── state.json        # daemon-internal state
│   ├── daemon.pid        # daemon PID
│   └── daemon.log        # daemon logs
├── mirrors/              # → ~/mirrors in container (bind mount)
├── volumes/              # bind sources declared under `volumes:` in config.yaml
└── files/                # symlink sources for `avm-bridge link` (→ ~/.avm-files in container)
```

With the Claude-defaults `config.yaml`, `volumes/` contains `ssh/`,
`git/`, `claude/`, and `claude.json` — the credential and Claude-state
bind sources. Nothing under `~/.avm/` has a fixed layout other than
`daemon/` and `mirrors/`; everything else is what you declare in
`config.yaml`.

## How `avm create` / `avm start` Work

Both commands share post-creation orchestration in `lib/session.ts`. The
difference is what happens first:

- **`avm create`** runs `docker run` with all mount arguments from
  `getDockerMountArgs`, creating and starting the container in one step.
- **`avm start`** runs `docker start` (the container already exists with
  its mounts baked in from creation).

Both then run `applyPostCreationSetup`, which persists `AVM_*` env vars
into `/etc/environment` (so SSH sessions inherit them), symlinks
image-shipped skills (`/opt/avm/skills/*`) into each `skills_dir`
declared in `config.yaml`, and ensures `avm-bridge` is executable.
Per-repo symlinks are no longer baked into the container — they're
applied on demand by `avm-bridge link` (the bridge fetches the current
`config.yaml` from the daemon at call time, so edits take effect
without `avm start`).

Mounts are established at container creation time and persist across
`docker stop` / `docker start`. The container only sees explicitly
mounted paths — no lockdown step is needed.

## Cloning Repos From Inside the Container

`avm create` and `avm start` deliberately don't clone repos. That's the
agent's job, inside the container, via `avm-bridge clone <name>`. The
CLI's job is to make the tools available: mirrors at `~/mirrors/`,
overlay files at `~/.avm-files/`, and `avm-bridge` on the PATH. The
in-container `AGENTS.md` (generated from `templates/agents.md`, mounted
per the `agents_md` config) tells the agent how to use them.

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

### Customizing the in-container guidance file (AGENTS.md / CLAUDE.md)

`avm` regenerates `~/.avm/AGENTS.md` on every command (from
`templates/agents.md`, plus a dynamic services section) and bind-mounts
it into each container. The default in-container path is
`~/AGENTS.md`. Override with `agents_md` in `~/.avm/config.yaml`:

```yaml
agents_md: ~/CLAUDE.md                  # single target
agents_md: [~/AGENTS.md, ~/CLAUDE.md]   # multiple, e.g. when running
                                        # both Claude and another harness
```

Set `agents_md: []` to skip the mount entirely.

Because `~/.avm/AGENTS.md` is regenerated on every command, do not
hand-edit it — your changes will be overwritten. Put persistent
in-container instructions in your harness's own user-level file
(e.g. `~/.claude/CLAUDE.md` for Claude).

### Customizing the in-container skills directory

The `avm-*` skills (`avm-repos`, `avm-docker`, `avm-services`,
`avm-editor`) ship inside the image at `/opt/avm/skills/`. Set
`skills_dir` to have them symlinked into one or more harness-specific
skill paths:

```yaml
skills_dir: ~/.claude/skills
skills_dir: [~/.claude/skills, ~/.codex/skills]
```

Unset → no symlinks created (the skills are still readable at
`/opt/avm/skills/` if you want to reference them manually).

### Claude desktop integration

When `integrations.claude_desktop: true` in `~/.avm/config.yaml`,
`avm ssh-config` mirrors every container with an SSH port into
`~/.claude/settings.json` `sshConfigs` as it's created or destroyed.
The Claude desktop app picks the entries up automatically; from there
you can start a Claude Code session that runs inside the avm container
with one click.

`avm ssh-config install --desktop` enables the integration and applies
the initial sync. `avm ssh-config install --no-desktop` disables it
explicitly. The toggle lives in `config.yaml` — edit it there to flip
the integration on/off without rerunning `install`. `avm ssh-config
uninstall` removes the SSH `Include` line and tears down any avm entries
from `~/.claude/settings.json`.

Only containers with the auto-generated `avm-<5 char>` name are
registered — user-named containers (`avm create my-feature`) are not
added to the dropdown. All other top-level keys in
`~/.claude/settings.json` (hooks, permissions, plugins) and any
non-avm `sshConfigs` entries are preserved verbatim across syncs.

### Claude notification hooks

When `integrations.claude_notifications: true` in `~/.avm/config.yaml`,
`avm notify install` writes Claude `Notification` and `Stop` hooks into
`~/.claude/settings.json` so the host gets a sound + macOS banner when
the in-container Claude Code needs attention or finishes a turn. Tune
the sounds via the `notifications:` block in `config.yaml`.

Disable by setting `integrations.claude_notifications: false` and
running `avm notify uninstall` to clean up the hooks.

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

2. **Use from inside a container** (the in-container agent runs these):

```bash
avm-bridge service start chrome    # start Chrome on the host
avm-bridge service status chrome   # check if it's running
avm-bridge service stop chrome     # stop it
```

The daemon starts automatically when any avm command needs it (e.g.
`avm create`, `avm start`, `avm attach`, `avm service ls`). Use
`avm daemon start` / `stop` / `restart` for explicit control.

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

The editor is configured via `editor:` in `~/.avm/config.yaml`. Supported
values are `code`, `cursor`, and `zed`. `code` and `cursor` use the
Dev Containers attached-container protocol (no host SSH config needed).
`zed` connects over SSH and requires `avm ssh-config install` so that
`ssh avm-<id>` resolves from the host.

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
  `~/.avm/volumes/claude.json` exists on the host (`touch
  ~/.avm/volumes/claude.json`). It's mounted as a file into every
  container per the `claude.json:~/.claude.json` volume in the Claude
  defaults; without it, Claude Code runs first-run setup every time.
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
