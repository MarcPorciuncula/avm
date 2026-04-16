---
name: avm
description: Use when the user asks to spin up, attach to, list, or clean up avm sandbox containers, or configure avm (Dockerfile, volumes, caches, config.yaml, mirrors, credentials, services, daemon) — the CLI for managing Docker-based Claude Code sandboxes.
---

# Using `avm`

`avm` is a CLI (installed globally via `pnpm link --global` from this
repo) that manages sandboxed agent containers via Docker. Use it when
the user wants to work inside an isolated container with full Claude Code
autonomy (`--dangerously-skip-permissions`).

## When to use this skill

Invoke this skill when the user says things like:
- "give me a sandbox / container / workspace"
- "spin up an avm"
- "start a fresh container to work on X"
- "list my containers" / "what sandboxes are running"
- "clean up that container" / "tear it down"
- "attach to the sandbox"
- "set up avm on this machine"

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
avm editor [id]           # Open a container in VS Code / Cursor (auto-detects, saves preference)
avm stop <id...>          # Stop one or more containers without destroying them
  --all                   # Stop every running session container
avm clean <id...>         # Stop and delete one or more session containers
  --all                   # Clean every session container
avm ssh-config            # Regenerate ~/.avm/ssh_config from current containers
avm ssh-config install    # Add Include line to ~/.ssh/config (enables `ssh avm-<id>`)
avm ssh-config uninstall  # Remove the Include line
avm provision             # Build or rebuild the Docker images (core + user)
avm daemon start          # Start the avm daemon (auto-started by avm create if needed)
avm daemon stop           # Stop the avm daemon
avm daemon status         # Show daemon URL, PID, and reachability
avm service ls            # List declared host services and their state
avm service start <name>  # Start a host service
avm service stop <name>   # Stop a host service
avm service status <name> # Show status of a host service
```

Images are infrastructure — excluded from `avm list` and never touched
by `avm clean`. Rebuild them with `avm provision`.

IDs are the 5-char suffix after `avm-` (e.g. `k7xf2`). Prefixes work as
long as they're unambiguous. `avm clean` with a prefix prompts for
confirmation before deleting.

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

Start the container, attach, then clone + link from inside:

```
avm create --attach
# (inside the container)
cd ~/work
git clone --reference ~/mirrors/<repo>.git \
  git@github.com:<owner>/<repo>.git \
  <repo>
cd <repo>
avm-link            # applies any symlinks declared in ~/.avm/config.yaml
```

`avm` doesn't clone repos for you — that's the agent's job inside the
container. The CLI's job is to make the mirrors, overlay files, and
`avm-link` available.

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

Running `avm ssh-config install` (or accepting the prompt on first
`avm create`) wires an `Include ~/.avm/ssh_config` line into the user's
`~/.ssh/config`, so `ssh avm-<id>` works from any terminal without
extra flags. Useful for tools that key off the literal `ssh` command
(e.g. Warp's terminal "warpify" detection, Cursor remote-SSH).

Containers created before SSH support was added won't have an SSH port
assigned. Recreate them with `avm create` to get one.

## Inside the Container

Once attached, the user (or Claude inside the container) sees:

- `~/work/` — project repos (you clone them here; persists across stop/start)
- `~/mirrors/` — bare git mirrors for fast clones (mounted from host)
- `~/.avm-files/` — overlay files for `avm-link` to symlink from (read-only in practice)
- `~/.ssh/`, `~/.claude/`, `~/.claude.json`, `~/.config/git/config` — credentials and settings
- `clauded` — alias for `claude --dangerously-skip-permissions`
- `avm-link` — applies the per-repo symlinks from `~/.avm/config.yaml`
- `avm-bridge` — CLI for coordinating with the host daemon (start/stop
  host services, open files in the user's editor). See the avm-services
  and avm-editor skills inside the container for usage.
- Docker (DinD) — run `start-dockerd` inside the container, then `docker build`, `docker run`, etc. work normally

The container only sees explicitly mounted paths. There is no access to
the host filesystem beyond what `avm` mounts.

## First-time setup on a fresh machine

If the user says "set up avm" or the CLI errors out because `~/.avm/`
is empty, walk them through populating it. Everything `avm` needs at
runtime lives under `~/.avm/`.

Minimum for a working session:

1. **SSH key and config** at `~/.avm/system/credentials/ssh/`. Offer to
   generate a new `id_ed25519` if they don't have one to dedicate to
   agent containers, or copy an existing one from `~/.ssh/`. The
   directory is mounted as `~/.ssh` inside every container, so treat it
   as the agent's GitHub identity.
2. **Git identity** at `~/.avm/system/credentials/git/config`.
   Either copy `~/.gitconfig` or write a minimal one with `user.name`
   and `user.email`.
3. **Dockerfile** at `~/.avm/Dockerfile`. Start from
   `<avm-repo>/examples/Dockerfile` (copy and edit). This layers your
   toolchain on top of the `avm-core:latest` image — Go, Docker CLI,
   language runtimes, etc. Place any files needed by the Dockerfile in
   `~/.avm/build-context/`.
4. **Run `avm provision`** to build the Docker images (core + user).
   Layer caching makes subsequent rebuilds fast.
5. **Run `avm create --attach`** to start a session.

Optional but recommended:

- **Mirrors** at `~/.avm/mirrors/<repo>.git` via
  `git clone --mirror git@github.com:<owner>/<repo>.git
  ~/.avm/mirrors/<repo>.git`. Fast reference-clones inside every
  container.
- **`~/.avm/config.yaml`** declaring bind-mount volumes (caches, package
  stores) and per-repo symlinks (env files, config overrides). See the
  README for the schema. Drop source files under `~/.avm/volumes/` and
  `~/.avm/files/`.

Don't create `~/.avm/` directories the user won't populate. Empty
scaffolding clutters their home; `avm create` creates the pieces it
needs on demand (`ensureHostScaffolding` in `lib/session.ts`).

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

The daemon is auto-started by `avm create` if not already running.
For manual control:

```
avm daemon start     # start if not running
avm daemon stop      # stop
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

Volumes in `~/.avm/config.yaml` are **Docker bind mounts**. At container
start, each volume replaces the directory at the target path with the
contents of the host directory. This means **a volume masks whatever the
image had at that path** — including toolchain binaries installed during
`docker build`.

### The masking problem

If the Dockerfile installs Rust (`rustup`, `cargo`) into `~/.cargo/`,
and `config.yaml` declares `cargo:~/.cargo`, the bind mount replaces the
entire `~/.cargo` directory with an empty host folder. The toolchain
binaries disappear at runtime even though they were installed at build
time.

### The fix: mount cache subdirectories, not toolchain roots

Only mount the directories that hold downloaded/cached artifacts — not
the directory that contains the toolchain binaries.

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

## Your role as the host agent

You are a host agent. Your job is helping the user configure and
operate their avm setup — not doing codebase work. Codebase work
happens inside containers, performed by avm agents.

**You MUST NOT perform actual work inside containers directly.** Do not
use `avm exec` to edit files, run builds, install packages, commit
code, or do anything that constitutes codebase work. That defeats the
purpose of sandboxing.

`avm exec` is available for:
- Ad hoc debugging when the user explicitly asks (e.g. "check what's
  in that container's work directory")
- Dispatching to an inner agent when the user explicitly asks (e.g.
  starting a `claude` session inside a container)

If the user asks you to do work that belongs inside a container,
create or start a container and let the avm agent handle it.

## Things NOT to do

- **Don't do codebase work inside containers.** See above. Delegate
  to the avm agent.
- **Don't create containers by calling `docker` directly.** Always go
  through `avm create` so mounts, credentials, and setup are applied
  correctly.
- **Don't ask the user which repo or branch to use before starting a
  container.** `avm create` intentionally doesn't take a repo. The user
  (or Claude inside the container) picks that once they're inside.
- **Don't auto-clean containers.** Cleanup is the user's decision. The
  only cleanup command is `avm clean`.
- **Don't run the CLI from inside a container.** `avm` is host-side
  only — it controls Docker from macOS. Inside a container, the user
  just works with the repos directly.
- **Don't edit `examples/Dockerfile` in the repo.** That's the shipped
  example. User customizations go in their own `~/.avm/Dockerfile`.

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
- **Claude Code inside the container runs onboarding every time**: check
  that `~/.avm/system/claude.json` exists on the host.
