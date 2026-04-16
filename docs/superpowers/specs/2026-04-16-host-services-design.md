# Host Services — Design

Date: 2026-04-16
Status: Draft

## Problem

Agents inside avm containers need to use services that run on the host
machine. The first concrete case is Chrome with remote debugging on
`localhost:9222`, consumed by the `chrome-devtools` MCP. Postgres running
in a host-side Docker container is a second, shape-similar case.

Three things are broken today:

1. **The user forgets to start Chrome.** Starting it requires remembering
   a specific command with `--remote-debugging-port` and a dedicated
   user-data-dir. There is no affordance in avm for this.
2. **Inner agents duplicate services.** A project's README or
   `docker-compose.yaml` directs the agent to run a local Postgres. The
   agent doesn't know one already exists on the host; it starts a second
   copy inside the container, wasting resources and confusing state.
3. **No lifecycle control from inside the container.** avm containers
   use docker-in-docker (`--privileged`, no host socket mounted), so
   agents cannot reach host processes or host Docker containers to
   start, stop, or check them.

The network path is fine — avm uses OrbStack's `--network host`, so
containers reach `localhost` on the host directly. The gap is
**control**, not connectivity.

## Goals

- One uniform abstraction — "host services" — covering both host
  processes (Chrome) and host Docker containers (Postgres).
- Inner agents can start, stop, and check services on demand.
- Services persist independently of any single container. Stopping a
  container doesn't stop services; cleaning a container doesn't stop
  services.
- Agents are informed about which services exist and must tolerate them
  going away (user closed Chrome, service crashed, another agent
  stopped it).
- Resource-conscious: services are started on first request, not
  eagerly.
- Design the host-side component as the seed of a broader avm control
  plane (agent oversight, notifications), without building those
  features now.

## Non-Goals

- No built-in service presets. Users declare services in
  `~/.avm/config.yaml` themselves; the Chrome block is shipped as a
  copy-paste example in `examples/config.yaml` and the README.
- No refcount or idle auto-stop in the first version. Start/stop is
  manual and idempotent; agents call what they need.
- No event stream / notifications in this spec. The API is versioned
  (`/v1/...`) so streaming endpoints can be added later without
  breakage.
- No Docker Compose support. `kind: docker` controls a pre-existing
  named container; creation is still the user's responsibility.
- No sibling RPC surfaces in this spec. The same daemon + shim + auth
  will host an editor-invocation RPC (`OpenInEditor`, see the sibling
  spec `2026-04-16-host-editor-design.md`) and, later, notifications
  and agent oversight. This spec delivers the infrastructure; siblings
  reuse it.

## Architecture

### Repo structure: pnpm workspaces

The repo moves to a pnpm workspaces layout with four packages:

```
pnpm-workspace.yaml
packages/
  avm/                  # host CLI (the existing CLI, relocated)
    package.json
    src/
      cli/              # citty entrypoint + subcommands (create, start, service, …)
      lib/              # config, session, image, vm helpers
  avm-daemon/           # host-side Connect server, owns all shared state
    package.json
    src/
      server.ts         # Connect server setup + HTTP listener
      services.ts       # ServicesService handlers
      registry.ts       # in-memory service registry, health checks, process bookkeeping
      auth.ts           # token management, Connect auth interceptor
      launchd.ts        # plist generation + load/unload
      state.ts          # state storage (daemon-internal; format is an implementation detail)
  avm-bridge/           # in-container CLI
    package.json
    src/
      cli/              # citty entrypoint + subcommands (service, editor)
  shared/               # proto types, Connect client factories
    package.json
    src/
      bridge-client.ts  # Connect client for bridge API (used by avm-bridge)
      host-client.ts    # Connect client for host API (used by avm)
      gen/              # Buf-generated TypeScript from protos
proto/                  # .proto source files (not a package; Buf generates into packages/shared)
  avm/bridge/v1/        # bridge API — called by avm-bridge (container token auth)
    services.proto
  avm/host/v1/          # host API — called by avm CLI (host secret auth)
    containers.proto
buf.yaml
buf.gen.yaml
```

Dependency graph:
- `packages/shared` — no internal dependencies. All three other
  packages depend on it for proto types and client factory.
- `packages/avm-daemon` — depends on `shared`. Owns its own state
  storage; neither CLI touches it directly.
- `packages/avm` — depends on `shared`. Talks to the daemon over
  Connect for state-touching operations (token registration, service
  control). Calls Docker directly for container lifecycle.
- `packages/avm-bridge` — depends on `shared`. Talks to the daemon
  over Connect only.
- `avm` spawns `avm-daemon` but has no code dependency on it.
- `avm` and `avm-bridge` never depend on each other.

Each package has its own esbuild entrypoint:
- `packages/avm` → `dist/avm.mjs` (the host CLI, same as today)
- `packages/avm-daemon` → `dist/avm-daemon.mjs` (spawned by the host
  CLI or launchd)
- `packages/avm-bridge` → `dist/avm-bridge.mjs` (bind-mounted into
  containers)

The existing top-level `bin/avm.mjs` entrypoint wrapper continues to
point at `dist/avm.mjs`. `pnpm link --global` still installs `avm` on
the host PATH.

### Components

Three new components:

- **`avm-daemon`** — a long-running host-side process that owns service
  lifecycle and all shared state (tokens, PIDs, future agent/container
  metadata). Serves a Connect-over-HTTP API on `127.0.0.1:<port>`.
  Spawned by the host CLI or installed as a launchd agent.
- **`avm-bridge`** — a separate CLI that lives inside every avm
  container. Built from `packages/avm-bridge`, bundled as a single JS
  file, bind-mounted from the repo's `dist/` directory, invoked via
  the container's Node/Bun.
- **`avm service`** — a new subcommand on the host CLI that talks to
  the daemon over Connect, giving the user and host agent parity with
  what `avm-bridge service` provides from inside containers.

Containers reach the daemon via host networking — `localhost:$AVM_HOST_PORT`.
No socket mounts, no SSH, no extra privileges.

```
┌────────────────── host (macOS) ──────────────────┐
│                                                  │
│  avm (host CLI) ──rpc──> avm-daemon (127.0.0.1)  │
│                            │                     │
│                            ├─ spawns Chrome      │
│                            ├─ docker start pg    │
│                            └─ owns state.db      │
│                                                  │
└──────────┬───────────────────────────────────────┘
           │ host networking
┌──────────▼──────────────── container ────────────┐
│  avm-bridge ──rpc──> avm-daemon                  │
│  agent runs: `avm-bridge service start chrome`   │
└──────────────────────────────────────────────────┘
```

### RPC surface

Two separate proto packages, each with its own auth domain. Buf
generates TypeScript for both into `packages/shared/src/gen/`.

#### Bridge API (`avm.bridge.v1`) — called by avm-bridge, container token auth

```proto
// proto/avm/bridge/v1/services.proto
syntax = "proto3";
package avm.bridge.v1;

service ServicesService {
  rpc ListServices(ListServicesRequest) returns (ListServicesResponse);
  rpc GetService(GetServiceRequest)     returns (Service);
  rpc StartService(StartServiceRequest) returns (Service);
  rpc StopService(StopServiceRequest)   returns (Service);
}

message Service {
  string name      = 1;
  Kind   kind      = 2;
  State  state     = 3;
  int32  pid       = 4;
  string last_error = 5;
  google.protobuf.Timestamp last_check_at = 6;
}

enum Kind  { KIND_UNSPECIFIED = 0; PROCESS = 1; DOCKER = 2; }
enum State { STATE_UNSPECIFIED = 0; UP = 1; DOWN = 2; STARTING = 3; STOPPING = 4; UNKNOWN = 5; }
```

Future additions to this package: `EditorService` (see sibling spec).

All RPCs are idempotent. `StartService` on an up service is a no-op
that returns the current state. `StopService` on a down service is
the same. "Is it actually up?" is answered by the health check, not
by daemon bookkeeping — so a service killed out-of-band reports `DOWN`
on the next call.

#### Host API (`avm.host.v1`) — called by host CLI, host secret auth

```proto
// proto/avm/host/v1/containers.proto
syntax = "proto3";
package avm.host.v1;

service ContainerService {
  rpc RegisterContainer(RegisterContainerRequest)     returns (RegisterContainerResponse);
  rpc UnregisterContainer(UnregisterContainerRequest) returns (UnregisterContainerResponse);
}

message RegisterContainerRequest   { string name = 1; }
message RegisterContainerResponse  { string token = 1; }
message UnregisterContainerRequest { string name = 1; }
message UnregisterContainerResponse {}
```

Future additions to this package: service management parity RPCs
(so `avm service ls` on the host calls the same daemon), container
introspection, etc.

#### Shared types

Messages that appear in both APIs (e.g. `Service`, `Kind`, `State`)
live in a shared `avm.common.v1` package that both import, avoiding
duplication. Alternatively, each package owns its own copies if the
shapes diverge — to be decided during implementation based on whether
the host API needs different fields (e.g. richer metadata for
monitoring).

### Authentication

The daemon's API has two distinct auth domains with separate callers,
separate trust levels, and separate token mechanisms.

#### Auth domain 1: Host CLI → daemon (`avm.host.v1`)

The host CLI calls `avm.host.v1` RPCs (`ContainerService`, and future
host-side management). These must be restricted to the host CLI — a
container must never be able to call them.

**Host secret.**

- The daemon generates a 32-byte random secret (base64url) on first
  start and persists it at `~/.avm/daemon/host.secret` (`0600`).
- This file lives under `~/.avm/daemon/`, which is **never mounted**
  into avm containers. Containers cannot read it.
- The host CLI reads the secret from disk and sends it as
  `Authorization: Bearer <host-secret>` on every `avm.host.v1` RPC.
- The daemon validates the bearer token against the on-disk secret.
  Mismatch → `Unauthenticated`.
- If the secret file doesn't exist (daemon hasn't started yet, or was
  reset), the host CLI errors with a clear message pointing the user
  at `avm daemon start`.

#### Auth domain 2: avm-bridge → daemon (`avm.bridge.v1`)

avm-bridge calls `avm.bridge.v1` RPCs (`ServicesService`, `EditorService`,
and future per-container operations). These require proof that the
caller is a specific registered container.

**Container token lifecycle.**

- `avm create` ensures the daemon is running, then calls
  `RegisterContainer(name)` (via `avm.host.v1`, authenticated with
  the host secret) → the daemon generates a 32-byte random token
  (base64url), persists it in its state store, and returns it. The
  host CLI passes the token to `docker run -e AVM_HOST_TOKEN=<value>`.
- `avm stop` / `avm start` don't touch the token — env vars persist
  with the container across `docker stop`/`docker start`, so the
  token survives.
- `avm clean <id>` calls `UnregisterContainer(name)` (via
  `avm.host.v1`, authenticated with the host secret), which revokes
  the token from the daemon's state store.

**Container handshake.**

- avm-bridge sets `Authorization: Bearer $AVM_HOST_TOKEN` on every
  `avm.bridge.v1` request. If the env var is missing it exits with a
  clear error.
- A Connect interceptor on the `avm.bridge.v1` routes looks up the
  token; on match it attaches `{ container_name }` to the request
  context, on miss it returns `Unauthenticated`.
- `ServicesService` requires container auth but is identity-agnostic —
  any authenticated container may list/start/stop any service. The
  identity is recorded in logs only.
- `EditorService` and future per-container RPCs read `container_name`
  from the request context to authorize per-container behavior.

#### Summary

| Caller     | Token source                      | Mounted into containers? | Proto package    |
|------------|-----------------------------------|--------------------------|------------------|
| Host CLI   | `~/.avm/daemon/host.secret` file  | No (never)               | `avm.host.v1`    |
| avm-bridge | `$AVM_HOST_TOKEN` env var         | Yes (env-only)           | `avm.bridge.v1`  |

#### Storage

The daemon owns its state store. The format is an internal
implementation detail — JSON with atomic writes, SQLite KV, or
anything else the daemon chooses. Neither CLI reads or writes the
state directly (except the host CLI reading `host.secret`). The
state lives under `~/.avm/daemon/` with restrictive permissions
(`0700` on directory, `0600` on files).

#### Threat model and what's out of scope

Two threats mitigated:

1. A compromised process inside container A impersonating container B
   to the daemon. Prevented by per-container bearer tokens.
2. A compromised container calling admin RPCs (registering/
   unregistering other containers). Prevented by the host secret
   never being mounted into containers.

Not mitigated (and not in scope): a compromised host user account,
a malicious `avm` CLI, or an attacker who has already escaped the
container.

### Service configuration

Extend `~/.avm/config.yaml` with two new top-level keys:

```yaml
# Optional daemon block. Port is exposed to containers as $AVM_HOST_PORT.
daemon:
  port: 6970            # default

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
    container: local-postgres   # must already exist on the host
    check:
      tcp: 127.0.0.1:5432
```

Schema rules:

- `kind` is required; `process` or `docker`.
- For `process`: `command` is required (array; first element is the
  binary, rest are args). No shell interpretation — `avm` invokes it
  directly, inherits the user's environment.
- For `docker`: `container` is required (name of a host-side container
  the user has already created). `docker start <name>` / `docker stop <name>`
  control it.
- `check` is required. `tcp: host:port` is the only supported form in
  v1. `http: <url>` and `command: <shell>` can be added later without
  schema breakage.
- Service names match `[a-zA-Z0-9._-]+`, mirroring the existing repo
  name rule in `lib/config-file.ts`.

Parsing/validation lives alongside the existing code in
`lib/config-file.ts`. Invalid entries throw with a clear message
identifying the offending key, same as today.

### Daemon behavior

**Start**. The daemon reads `config.yaml` on boot, builds an in-memory
registry of declared services, and binds `127.0.0.1:<port>`. Config is
re-read on every RPC (or on a SIGHUP) so editing `config.yaml` doesn't
require a restart.

**`StartService`**:

1. Check current state via the health check. If `UP`, return.
2. `kind: process` — spawn the command with `child_process.spawn`,
   detach it from the daemon (so the daemon can exit without killing
   the service), record PID.
   `kind: docker` — shell out: `docker start <container>`.
3. Poll the health check every 250 ms for up to 10 s. Return
   `state: UP` on success, `state: DOWN` with `last_error` populated
   on timeout.

**`StopService`**:

1. Check current state. If `DOWN`, return.
2. `kind: process` — SIGTERM the recorded PID; SIGKILL after 5 s if
   still alive. If no recorded PID (daemon was restarted), do best-effort
   lookup via the check (e.g., find process listening on the checked
   port) or report `UNKNOWN` — to be refined during implementation.
   `kind: docker` — `docker stop <container>`.
3. Return final state.

**`ListServices` / `GetService`** run the health check and return
current state. They never mutate anything.

**State persistence**. The daemon owns all persistent state: service
PIDs, container tokens, and any future metadata. The storage format
is an internal implementation detail of the `avm-daemon` package
(JSON with atomic writes for now; can migrate to SQLite KV later
without touching any CLI code). The health check is always the source
of truth for service state — persisted PIDs are a best-effort hint
for `StopService` after daemon restart.

Logs go to `~/.avm/daemon/daemon.log`. The daemon writes its own PID
to `~/.avm/daemon/daemon.pid` on startup so `avm daemon stop` can
find it.

**Directory layout**. New:

```
~/.avm/daemon/
├── host.secret      # host CLI auth token (generated on first daemon start, never mounted into containers)
├── state.json       # daemon-internal: container tokens, service PIDs, metadata
├── daemon.pid       # daemon process ID (for avm daemon stop)
└── daemon.log
```

Documented in `README.md` under "Host Data Layout".

### Daemon lifecycle

Two modes:

- **Launchd agent (recommended)**. `avm daemon install` writes
  `~/Library/LaunchAgents/ai.alcova.avm.daemon.plist` and loads it.
  `avm daemon uninstall` unloads and removes. The daemon runs on login,
  restarts on crash, survives reboots.
- **Lazy spawn (fallback)**. `avm create` / `avm start` check whether
  the daemon is reachable (a Connect health probe). If not, they spawn
  `dist/avm-daemon.mjs` detached from the current process. This is
  enough for casual users who haven't run the install step.

Additional subcommands on the host CLI:

- `avm daemon start` — spawn the daemon (or verify it's already up).
- `avm daemon stop` — read PID file, send SIGTERM.
- `avm daemon status` — print daemon URL and reachability.
- `avm daemon install` / `uninstall` — manage the launchd agent.

Running `dist/avm-daemon.mjs` directly (no subcommand) starts the
server in the foreground — this is what launchd invokes.

### Container integration

Additions to `applyPostCreationSetup` in `lib/session.ts` and the
`docker run` arguments built by `avm create`:

1. **Mount the shim.** Add a bind-mount entry in `getDockerMountArgs`
   for `<repo>/dist/avm-bridge.mjs` → `/usr/local/bin/avm-bridge`. Since
   the file has a `#!/usr/bin/env node` shebang and executable
   permission, it runs as a command.
2. **Provision the bearer token.** `avm create` ensures the daemon is
   running (lazy-spawn if needed), then calls `RegisterContainer(name)`
   on the daemon. The daemon generates the token, persists it, and
   returns it. The host CLI passes `-e AVM_HOST_TOKEN=<value>` to
   `docker run`. The token is env-only — never written inside the
   container.
3. **Export `AVM_HOST_PORT`.** Pass `-e AVM_HOST_PORT=<port>` on
   `docker run`. The port is read from `config.yaml` (`daemon.port`,
   default 6970). Existing containers don't pick up a port change
   until the next `avm create`; this is fine, ports rarely change.
4. **Export `AVM_CONTAINER_NAME`.** Pass `-e AVM_CONTAINER_NAME=<name>`
   so the shim can send the container's identity in future RPCs
   (editor, notifications). Not used by services, but cheap to wire
   in now for consistency — the daemon authoritatively resolves
   identity from the token, so this is advisory only.
5. **Write the "Host Services" section.** After seeding
   `CLAUDE.md` (the existing step that copies `templates/vm-claude.md`
   to `~/.avm/system/claude/CLAUDE.md` if absent), generate a sidecar
   file inside the container at `/home/agent/.claude/host-services.md`
   listing the declared services and usage. `templates/vm-claude.md`
   is updated to instruct the agent to consult this file. The sidecar
   is regenerated on every `avm create`/`start`; the user-editable
   `CLAUDE.md` is not touched after first seed (existing contract).

`avm clean <id>` calls `UnregisterContainer(name)` on the daemon to
revoke the token as part of its existing teardown.

### `avm-bridge` (in-container CLI)

Built from `packages/avm-bridge`, bundled to `dist/avm-bridge.mjs`.
Bind-mounted into every container at `/usr/local/bin/avm-bridge`.
Runs under the container's Node or Bun (already present for
development).

Command surface:

```
avm-bridge service ls
avm-bridge service status <name>
avm-bridge service start  <name>
avm-bridge service stop   <name>
```

Output is human-readable by default; `--json` dumps the raw response.
Exit code 0 on success, non-zero on RPC failure (network error,
`last_error` populated, etc.). The shim constructs its target URL from
`$AVM_HOST_PORT` — no flags, no config file inside the container.

### Generated agent guidance

`templates/vm-claude.md` gains a short section instructing the agent
to read `~/.claude/host-services.md` and use `avm-bridge`. The sidecar
file is generated per-container and contains content like:

```markdown
# Host Services

Services running on the host are controllable via `avm-bridge`. Use the
host copy rather than starting your own — especially when a project's
README or `docker-compose.yaml` suggests running them locally.

## Available services

- **chrome** (host process) — Chrome with CDP on `localhost:9222`.
  Used by the `chrome-devtools` MCP.
- **postgres** (host docker container) — Postgres on `localhost:5432`.

## Usage

    avm-bridge service status chrome
    avm-bridge service start  chrome
    avm-bridge service stop   chrome
    avm-bridge service ls

Services are started on request (idempotent). They may stop at any
time — crashes, user-initiated, another agent stopping them. Always
check status before use and be prepared to restart.
```

The list is generated from `ListServices`. If the daemon is
unreachable at container creation time, a placeholder section
indicates that — the agent can retry by invoking `avm-bridge` later.

## File Changes

### Workspace scaffolding (new)
- `pnpm-workspace.yaml` — declares `packages/*`
- `packages/avm/package.json` — host CLI package (absorbs existing root deps)
- `packages/avm-daemon/package.json` — daemon server package
- `packages/avm-bridge/package.json` — in-container CLI package
- `packages/shared/package.json` — proto types + Connect client factory

### Proto + codegen (new)
- `proto/avm/bridge/v1/services.proto` — `avm.bridge.v1.ServicesService` (container token auth)
- `proto/avm/host/v1/containers.proto` — `avm.host.v1.ContainerService` (host secret auth)
- `buf.yaml`, `buf.gen.yaml` — Buf config; generates into `packages/shared/src/gen/`

### `packages/avm-daemon` — new files
- `src/server.ts` — Connect server setup + HTTP listener
- `src/services.ts` — ServicesService handlers
- `src/admin.ts` — AdminService handlers (register/unregister containers)
- `src/registry.ts` — in-memory service registry, health checks, process bookkeeping
- `src/auth.ts` — token management, Connect auth interceptor
- `src/state.ts` — state persistence (daemon-internal; format is an implementation detail)
- `src/launchd.ts` — plist generation + load/unload
- `src/main.ts` — entrypoint (starts server in foreground)

### `packages/avm` (host CLI) — new files
- `src/cli/commands/daemon.ts` — `avm daemon [start|stop|status|install|uninstall]`
- `src/cli/commands/service.ts` — `avm service [ls|status|start|stop]` (host-side parity, talks to daemon via Connect)

### `packages/avm` (host CLI) — modified files
- `src/cli/avm.ts` — register `daemon` and `service` subcommands
- `src/cli/commands/create.ts` — ensure daemon is up, call `RegisterContainer`, pass token to `docker run`
- `src/cli/commands/clean.ts` — call `UnregisterContainer` on teardown
- `src/lib/config-file.ts` — parse `daemon.` and `services.` blocks; extend `AvmConfig`
- `src/lib/session.ts` — mount the bridge, export `AVM_HOST_PORT` / `AVM_HOST_TOKEN` / `AVM_CONTAINER_NAME`, generate `host-services.md`, ensure daemon is up

### `packages/avm-bridge` (in-container CLI) — new files
- `src/cli/avm-bridge.ts` — citty entrypoint
- `src/cli/commands/service.ts` — `avm-bridge service [ls|status|start|stop]`

### `packages/shared` — new files
- `src/bridge-client.ts` — Connect client for `avm.bridge.v1` (used by avm-bridge)
- `src/host-client.ts` — Connect client for `avm.host.v1` (used by avm CLI)
- `src/config.ts` — shared config types (service definitions, daemon config)
- `src/gen/` — Buf-generated TypeScript from both proto packages

### Root-level changes
- `examples/config.yaml` — worked example including the Chrome block
- `templates/vm-claude.md` — point the avm agent at `~/.claude/host-services.md`
- `README.md` — "Host Services" section, `~/.avm/daemon/` in Host Data Layout, workspace layout
- `CLAUDE.md` — update File Structure to reflect workspace layout
- Root `package.json` — becomes workspace root (scripts, devDeps only)
- `bin/avm.mjs` — updated path to `dist/avm.mjs`

### Migration note
Existing files under `cli/`, `lib/` move into `packages/avm/src/`.
This is a one-time restructure as part of this feature. The workspace
migration and the feature implementation can be separate commits (or
even separate PRs) to keep the diff reviewable.

## Open Questions / Implementation Notes

- **Bun port.** If the project ports to Bun first (an independent
  decision the user is considering), the daemon and shim both move to
  Bun and the shim can later ship as a compiled single binary via
  `bun build --compile --target=bun-linux-<arch>`. The design here is
  agnostic — nothing changes in the interface, only the build step.
- **`docker` kind and pre-existence.** Starting a declared docker
  service when the named container doesn't exist should fail with a
  clear error pointing the user at "create the container first." No
  auto-`docker run`.
- **Config hot-reload.** The daemon re-reads `config.yaml` on every
  RPC (cheap; the file is small). A future optimization is mtime-based
  caching; not worth it in v1.
- **Daemon on non-macOS.** Launchd install is macOS-only. The daemon
  itself (Connect over HTTP) is platform-neutral; the install step
  errors cleanly on non-macOS. avm today is macOS-first per the README
  requirements, so this is acceptable.
- **Prescriptive container-lifetime language in the docs.** Unrelated
  to this design but flagged during brainstorming: several docs imply
  containers are "reusable workspaces" only. In reality they're used
  both semi-persistently and ephemerally. Revisit as a follow-up.

## Success Criteria

- `~/.avm/config.yaml` can declare a `chrome` service; a fresh
  `avm create --attach` lets the inner agent run
  `avm-bridge service start chrome` and then reach the CDP endpoint on
  `localhost:9222`.
- Stopping and restarting Chrome via `avm-bridge service stop/start`
  works, as does the host-side parity command `avm service stop/start`.
- Killing Chrome externally (Activity Monitor, `pkill`) is reflected
  correctly on the next `avm-bridge service status chrome`.
- Declaring a `postgres` service with `kind: docker` and an existing
  host container works via the same commands.
- The inner agent's generated `~/.claude/host-services.md` lists the
  declared services and the `avm-bridge` usage.
- Nothing changes for users who don't declare any `services:` —
  `avm create` / `avm start` behave exactly as before (aside from
  spawning an idle daemon, which is harmless).
