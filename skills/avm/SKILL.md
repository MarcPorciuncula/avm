---
name: avm
description: Use when the user explicitly mentions avm or an avm container by name/ID — to spin up, attach, list, clean, or configure avm (Dockerfile, volumes, caches, config.yaml, mirrors, credentials, services, daemon).
---

# Using `avm`

`avm` manages sandboxed agent containers via Docker.

## When to use this skill

Invoke this skill when the user explicitly mentions `avm` or an avm
container by name or ID (e.g. "spin up an avm", "my avm container",
"avm-k7xf2").

## Your role as the host agent

You are a host agent. Your job is helping the user configure and
operate their avm setup — not doing codebase work. Codebase work
happens inside containers, performed by avm agents.

**You MUST NOT perform actual work inside containers directly.** Do not
use `avm exec` to edit files, run builds, install packages, commit
code, or do anything that constitutes codebase work.

`avm exec` is available for:
- Ad hoc debugging when the user explicitly asks (e.g. "check what's
  in that container's work directory")
- Dispatching to an inner agent when the user explicitly asks (e.g.
  starting a `claude` session inside a container)

If the user asks you to do work that belongs inside a container,
create or start a container and let the avm agent handle it.

## Things NOT to do

- **Don't use `docker` directly for any container operation.** Always go
  through `avm` — it maintains state (registered containers, host secrets,
  mounts) that Docker knows nothing about.
- **Don't ask the user which repo or branch to use before starting a
  container.** `avm create` doesn't take a repo — that choice happens
  inside the container.
- **Never stop or clean a container through docker**, use the `avm` cli only.
- **Don't run the CLI from inside a container.** `avm` is host-side only.
- **Don't edit `examples/Dockerfile` in the repo.** User customizations
  go in `~/.avm/Dockerfile`.

## Commands

```
avm list                  # Show all session containers and their status
avm create [name]         # Create and start a new container
  --attach                # Attach to the container immediately (docker exec)
  --ssh                   # Attach via SSH instead of docker exec
avm start <id>            # Resume a stopped container (required id; prefix match)
  --attach                # Attach to the container immediately (docker exec)
  --ssh                   # Attach via SSH instead of docker exec
avm attach [id]           # Attach to a running container; interactive picker if no id
avm ssh <id>              # Connect to a running container over SSH
  --print-command         # Print the SSH command instead of connecting
  --print-config          # Print an SSH config block for ~/.ssh/config
avm exec <id> <cmd...>    # Run a command inside a container (non-interactive)
  --root                  # Run as root instead of agent
avm editor [id]           # Open a container in VS Code / Cursor / Zed (auto-detects, saves preference)
avm stop <id...>          # Stop one or more containers without destroying them
  --all                   # Stop every running session container
avm clean <id...>         # Stop and delete one or more session containers
  --all                   # Clean every session container
avm ssh-config            # Regenerate ~/.avm/ssh_config (and Claude desktop sshConfigs if installed)
avm ssh-config install    # Add Include line and (optionally) register containers in Claude desktop
avm ssh-config uninstall  # Remove the Include line and any avm entries from Claude desktop
avm provision             # Build or rebuild the Docker images (core + user)
avm daemon start          # Start the avm daemon (auto-started as needed by other commands)
avm daemon stop           # Stop the avm daemon
avm daemon restart        # Stop and start the avm daemon
avm daemon status         # Show daemon URL, PID, and reachability
avm service ls            # List declared host services and their state
avm service start <name>  # Start a host service
avm service stop <name>   # Stop a host service
avm service status <name> # Show status of a host service
```

Images are infrastructure — excluded from `avm list` and never touched
by `avm clean`. Rebuild them with `avm provision`.

IDs are the suffix after `avm-` (e.g. `k7xf2`). Prefixes work as
long as they're unambiguous. `avm clean` with a prefix prompts for
confirmation before deleting.

`avm editor` accepts `code`, `cursor`, or `zed` as the configured
editor. `code` and `cursor` use the Dev Containers attached-container
protocol; `zed` connects over SSH and requires `avm ssh-config install`.

## `avm create` vs `avm start`

- **`avm create`** makes a *new* container. Fails if the name already
  exists. Use for a fresh sandbox.
- **`avm start <id>`** resumes an *existing stopped* container. Fails if
  the container doesn't exist or is already running. Use to pick back up
  where a previous session left off — working copies under `~/work/`
  persist across stop/start.

## Typical Flows

### User wants a fresh sandbox

```
avm create --attach
```

`--attach` drops the user straight into the container once setup is done.

### User wants to resume a previous sandbox

```
avm list                  # find the id
avm start <id> --attach
```

Or if the container is already running, use `avm attach <id>` instead.

### User wants a working copy of a specific repo inside the container

Start the container, attach, then have the in-container agent clone:

```
avm create --attach
# (inside the container)
avm-bridge clone <repo>
```

`avm-bridge clone` resolves the host mirror at `~/mirrors/<repo>.git`,
runs a reference-based `git clone` into `~/work/<repo>`, and applies
per-repo symlinks declared in `~/.avm/config.yaml`. If there's no
mirror, pass `--url <git-url>`.

`avm` doesn't clone repos — cloning happens inside the container.

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

## SSH vs Attach

There are two ways to connect to a container:

- **`avm attach`** — uses `docker exec`. Always works, no setup needed.
  This is the default and the reliable fallback.
- **`avm ssh`** — connects over SSH. Better for third-party tools (Warp,
  VS Code remote-SSH, port forwarding, scp, SSH jump chains). sshd is
  started lazily on first use — no daemon runs by default.

Use `avm ssh --print-command <id>` to get the raw SSH command for
pasting into other tools, or `avm ssh --print-config <id>` to get an
SSH config block.

Running `avm ssh-config install` wires an `Include ~/.avm/ssh_config`
line into the user's `~/.ssh/config`, so `ssh avm-<id>` works from any
terminal without extra flags. Useful for tools that key off the literal
`ssh` command (e.g. Warp's terminal "warpify" detection, Cursor
remote-SSH).

The Claude desktop dropdown integration is controlled by
`integrations.claude_desktop` in `~/.avm/config.yaml`. When true,
`avm ssh-config` mirrors avm containers into `~/.claude/settings.json`
`sshConfigs` as they're created or destroyed. Pass `--desktop` to
`avm ssh-config install` to flip the config flag on (and apply the
initial sync), `--no-desktop` to flip it off. Editing
`integrations.claude_desktop` in `config.yaml` directly is also fine.

Containers without an SSH port assigned must be recreated with `avm create`.

## Inside the Container

Once attached, the user (or the in-container agent) sees:

- `~/work/` — project repos (the agent clones them here; persists across stop/start)
- `~/mirrors/` — bare git mirrors for fast clones (mounted from host)
- `~/.avm-files/` — overlay files for `avm-bridge link` to symlink from (read-only in practice)
- `~/AGENTS.md` (and `~/CLAUDE.md` when the example `config.yaml` sets
  `agents_md: ~/CLAUDE.md`) — generated guidance from
  `~/.avm/AGENTS.md`. Mount points depend on the user's `agents_md`
  config.
- Whatever `volumes:` declares in `~/.avm/config.yaml`. The Claude
  defaults mount `~/.ssh`, `~/.config/git/config`, `~/.claude/`, and
  `~/.claude.json`; non-Claude harnesses will look different.
- `avm-bridge` — CLI for coordinating with the host daemon. Includes
  `avm-bridge clone <name>` and `avm-bridge link` for repo setup, plus
  service control and host editor/browser integration. See the
  avm-repos, avm-services, and avm-editor skills inside the container.
- `clauded` — alias for `claude --dangerously-skip-permissions` (provided
  by the Claude block in `examples/Dockerfile`; absent if you removed
  that block).
- Docker (DinD) — run `start-dockerd` inside the container, then `docker build`, `docker run`, etc. work normally

The container only sees explicitly mounted paths. There is no access to
the host filesystem beyond what `avm` mounts.

## First-time setup on a fresh machine

If the user says "set up avm" or the CLI errors out because `~/.avm/`
is empty, walk them through populating it. The defaults reproduce
avm's Claude Code flavor: Claude in the image, credentials and Claude
state mounted in, AGENTS.md presented as CLAUDE.md, and Claude desktop
+ notifications wired up. For other harnesses, see the README's
"Using a different agent harness" section.

Minimum for a working Claude session:

1. **Drop in the Claude defaults**:
   - `cp <avm-repo>/examples/Dockerfile  ~/.avm/Dockerfile`
   - `cp <avm-repo>/examples/config.yaml ~/.avm/config.yaml`
2. **Seed credentials and Claude state**:
   - `mkdir -p ~/.avm/volumes/ssh ~/.avm/volumes/git ~/.avm/volumes/claude`
   - `touch ~/.avm/volumes/claude.json`
   - SSH key+config into `~/.avm/volumes/ssh/`. Offer to generate a
     fresh `id_ed25519` dedicated to agent containers, or copy an
     existing one from `~/.ssh/`. This is the agent's GitHub identity.
   - Git identity into `~/.avm/volumes/git/config`. Either copy
     `~/.gitconfig` or write a minimal one with `user.name` /
     `user.email`.
   - Leave `~/.avm/volumes/claude/` and `~/.avm/volumes/claude.json`
     empty — Claude Code fills them on first run inside a container.
3. **Edit `~/.avm/Dockerfile`** to match the user's stack. The example
   ships pnpm, Python, Go, Buf, Atlas, Task, golangci-lint, staticcheck,
   Docker CLI, and Claude Code. Drop anything they don't need; keep
   the labelled Claude Code block at the bottom unless they're using a
   different harness. Place any files needed by the Dockerfile in
   `~/.avm/build-context/`.
4. **Run `avm provision`** to build the Docker images (core + user).
   Layer caching makes subsequent rebuilds fast.
5. **Run `avm create --attach`** to start a session.

Optional but recommended:

- **Mirrors** at `~/.avm/mirrors/<repo>.git` via
  `git clone --mirror git@github.com:<owner>/<repo>.git
  ~/.avm/mirrors/<repo>.git`. Fast reference-clones inside every
  container.
- **Per-repo overlays** declared under `repos:` in
  `~/.avm/config.yaml`, with source files under `~/.avm/files/`. See
  the README for the schema.
- **More caches** under `volumes:` in `~/.avm/config.yaml`
  (`pnpm-store`, `go-build`, etc.). Source dirs live under
  `~/.avm/volumes/`.

Don't create `~/.avm/` directories the user won't populate. `avm create`
creates what it needs on demand.

## Migration from baked-in Claude defaults

If `avm` prints "Legacy ~/.avm/system layout detected" or you see
files moved under `~/.avm/volumes/`, this is the one-time migration
from the Claude-baked-in avm to the agent-agnostic avm. The CLI's
`migrateLegacyLayout` handles the file moves automatically, but
`~/.avm/config.yaml` still needs a few additions before the previous
behaviour is fully restored. Read
`docs/migration-to-agent-harness-decoupling.md` for the structured
runbook — apply the suggested `config.yaml` additions on the user's
behalf, then verify with a test `avm create --attach`.

## Host services and the daemon

The avm daemon is a host-side control plane that manages service
lifecycle (start/stop/health-check) for host processes and host Docker
containers. Agents inside containers communicate with it via
`avm-bridge` (installed automatically in every container).

### Configuring services

Services are declared in `~/.avm/config.yaml` under the `services:` key:

```yaml
daemon:
  port: 6970          # default, optional

services:
  chrome:
    kind: process
    command:
      - /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
      - --remote-debugging-port=9222
      - --user-data-dir=/tmp/chrome-devtools-profile
    check:
      tcp: 127.0.0.1:9222

  postgres:
    kind: docker
    container: local-postgres    # must already exist as a host docker container
    check:
      tcp: 127.0.0.1:5432
```

Two kinds:
- **`process`** — the daemon spawns a host process directly. Requires
  `command` (array of binary + args).
- **`docker`** — the daemon runs `docker start/stop` on a pre-existing
  host docker container. Requires `container` (container name).

Both require a `check` with `tcp: host:port` for health checking.

### Daemon lifecycle

The daemon auto-starts whenever an avm command needs it — `avm create`,
`avm start`, `avm attach`, `avm ssh`, `avm exec`, `avm editor`, and the
`avm service` subcommands all bring it up if it isn't already running.
For manual control:

```
avm daemon start     # start if not running
avm daemon stop      # stop
avm daemon restart   # stop and start (e.g. after upgrading the binary)
avm daemon status    # check URL, PID, reachability
```

### Host-side service management

From the host, the user can also manage services directly:

```
avm service ls               # list services + state
avm service start chrome     # start a service
avm service stop chrome      # stop a service
```

These use the same daemon as the in-container `avm-bridge service`
commands.

## Configuring volumes (caches and persistent data)

**Mount cache subdirectories, not toolchain roots.** Docker bind mounts
replace the target directory entirely at container start — a volume
targeting `~/.cargo` masks all Rust toolchain binaries installed during
`docker build`, even if the host directory is empty.

| Toolchain | Wrong (masks binaries) | Right (caches only) |
|-----------|------------------------|---------------------|
| Rust | `cargo:~/.cargo` | `cargo-registry:~/.cargo/registry` |
| Go | `go:~/go` | `go-build:~/.cache/go-build` |
| pnpm | `pnpm:~/.local/share/pnpm` | `pnpm-store:~/.local/share/pnpm/store` |

Example `config.yaml` volumes section:

```yaml
volumes:
  - pnpm-store:~/.local/share/pnpm/store
  - go-build:~/.cache/go-build
  - cargo-registry:~/.cargo/registry
```

Each source (left of `:`) is a directory name under `~/.avm/volumes/`.
Each target (right of `:`) is relative to `/home/agent/` (prefix with
`~/` for clarity, or use an absolute path starting with `/`). Create the
host directories before first use:

```bash
mkdir -p ~/.avm/volumes/pnpm-store ~/.avm/volumes/go-build ~/.avm/volumes/cargo-registry
```

### Diagnosing "tool disappeared after container start"

If a command works during `docker build` but is missing at runtime:

1. Check if a volume in `config.yaml` targets a parent of the install
   path.
2. Fix by narrowing the volume target to just the cache subdirectory.
3. Run `avm provision` to rebuild (usually not needed — the fix is in
   `config.yaml`), then `avm create` a new container.

### How volumes relate to the Dockerfile

- **Dockerfile** (`~/.avm/Dockerfile`): installs toolchains and binaries
  at build time. These live in the image layers.
- **Volumes** (`config.yaml`): persist caches across container
  stop/start/recreate cycles. They overlay specific directories at
  runtime.

They are complementary: the Dockerfile provides the tools, volumes keep
the caches warm. The volume must never shadow the tool install.

### Adding tools to the Dockerfile

**Always append new `RUN` blocks at the end of `~/.avm/Dockerfile`**, unless
the tool has a dependency on something installed later in the file.

If there is a real dependency order, place the block immediately after the
dependency and note it in a comment.

## If something goes wrong

- **`avm provision` fails with "Dockerfile not found"**: copy the example
  first — `cp examples/Dockerfile ~/.avm/Dockerfile` — then rerun.
- **`avm provision` fails during image build**: fix the Dockerfile issue
  and rerun `avm provision`. Docker layer caching means only failed
  layers rebuild.
- **`avm create` fails because a container already exists**: `avm list`
  and either `avm clean` the old one or pass a different name, or
  `avm start <id>` if the user wants to resume it.
- **`avm start <id>` fails with "already running"**: use
  `avm attach <id>` instead.
- **Claude Code inside the container runs onboarding every time**: with
  the Claude-defaults `config.yaml`, ensure `~/.avm/volumes/claude.json`
  exists on the host (`touch ~/.avm/volumes/claude.json`). The file
  bind-mount needs the source to exist before `docker run` succeeds.
