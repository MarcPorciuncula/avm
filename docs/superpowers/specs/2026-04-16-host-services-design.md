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

Two new components:

- **`avm daemon`** — a long-running host-side process that owns service
  lifecycle. Serves a Connect-over-HTTP API on `127.0.0.1:<port>`.
  Written in TypeScript, shares the existing build pipeline.
- **`avm-host`** — a thin Connect client CLI that lives inside every
  avm container. Bundled as a single JS file, bind-mounted from the
  repo's `dist/` directory, invoked via the container's Node/Bun.

Containers reach the daemon via host networking — `localhost:$AVM_HOST_PORT`.
No socket mounts, no SSH, no extra privileges.

```
┌──────────────── host (macOS) ─────────────────┐
│                                               │
│  ~/.avm/config.yaml ──> avm daemon (127.0.0.1)│
│                          │                    │
│                          ├─ spawns Chrome     │
│                          └─ docker start pg   │
│                                               │
└──────────┬────────────────────────────────────┘
           │ host networking
┌──────────▼────────────── container ───────────┐
│  avm-host (Connect client) --> daemon         │
│  agent runs: `avm-host service start chrome`  │
└───────────────────────────────────────────────┘
```

### RPC surface (v1)

Protos live at `proto/avm/v1/services.proto`. Buf is the codegen
toolchain (`buf.yaml`, `buf.gen.yaml`); generated TypeScript lands under
`gen/` and is consumed by both the daemon and the shim.

```proto
syntax = "proto3";
package avm.v1;

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
  int32  pid       = 4;  // only for kind=PROCESS and state=UP
  string last_error = 5; // empty when healthy
  google.protobuf.Timestamp last_check_at = 6;
}

enum Kind  { KIND_UNSPECIFIED = 0; PROCESS = 1; DOCKER = 2; }
enum State { STATE_UNSPECIFIED = 0; UP = 1; DOWN = 2; STARTING = 3; STOPPING = 4; UNKNOWN = 5; }
```

All four RPCs are idempotent. `StartService` on an up service is a
no-op that returns the current state. `StopService` on a down service
is the same. "Is it actually up?" is answered by the health check, not
by daemon bookkeeping — so a service killed out-of-band reports `DOWN`
on the next call.

### Authentication

The daemon binds `127.0.0.1` only, but "anything on loopback can call
it" is too loose: untrusted code inside a container could impersonate
another container when future RPCs (editor invocation, notifications)
begin to authorize based on container identity. We add a lightweight
per-container bearer token now, before those RPCs arrive.

**Token lifecycle.**

- `avm create` generates a 32-byte random token (base64url), writes
  it to `~/.avm/daemon/tokens.json` keyed by container name, and
  passes it to the container as `$AVM_HOST_TOKEN` via
  `docker run -e AVM_HOST_TOKEN=<value>`.
- `avm stop` / `avm start` don't touch the token — env vars persist
  with the container across `docker stop`/`docker start`, so the
  token survives.
- `avm clean <id>` removes the entry from `tokens.json` as part of
  the existing cleanup flow.

**Storage.**

`~/.avm/daemon/tokens.json` has the shape:

```json
{
  "avm-abcde": { "token": "…base64url…", "created_at": "2026-04-16T…" }
}
```

The daemon reads this file on every RPC (same pattern as `config.yaml`),
building an in-memory index `token → container_name`. File permissions
are `0600`; parent directory is `0700`.

**Shim and daemon handshake.**

- The shim sets `Authorization: Bearer $AVM_HOST_TOKEN` on every
  Connect request. If the env var is missing it exits with a clear
  error — this can only happen if the token was never provisioned
  (broken `avm create`) or the user manually unset it.
- A Connect interceptor in the daemon looks up the token; on match
  it attaches `{ container_name }` to the request context, on miss it
  returns `Unauthenticated`.
- `ServicesService` requires auth but is identity-agnostic — any
  authenticated container may list/start/stop any service. The
  identity is recorded in logs only.
- Sibling RPCs (editor, notifications) will read `container_name`
  from the request context to authorize per-container behavior.

**Threat model and what's out of scope.**

The threat being mitigated is a compromised process inside container
A impersonating container B to the daemon. This matters once RPCs
begin to behave differently per-caller. Not mitigated (and not in
scope): a compromised host user account, a malicious `avm` CLI, or
an attacker who has already escaped the container.

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

**State persistence**. The daemon keeps a tiny JSON file at
`~/.avm/daemon/state.json` mapping service name → last known PID.
This survives daemon restarts so `StopService` can still target the
right process. It is **not** a source of truth — the health check is.
Logs go to `~/.avm/daemon/daemon.log`.

**Directory layout**. New:

```
~/.avm/daemon/
├── state.json       # service name → last known PID (see above)
├── tokens.json      # container name → bearer token (see Authentication)
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
  the daemon is reachable (a Connect `GetService` or a trivial
  `/healthz` probe). If not, they spawn `avm daemon` detached from the
  current process. This is enough for casual users who haven't run the
  install step.

Additional subcommands:

- `avm daemon` — run in the foreground (what launchd invokes).
- `avm daemon status` — print daemon URL and reachability.

### Container integration

Additions to `applyPostCreationSetup` in `lib/session.ts` and the
`docker run` arguments built by `avm create`:

1. **Mount the shim.** Add a bind-mount entry in `getDockerMountArgs`
   for `<repo>/dist/avm-host.mjs` → `/usr/local/bin/avm-host`. Since
   the file has a `#!/usr/bin/env node` shebang and executable
   permission, it runs as a command.
2. **Provision the bearer token.** `avm create` generates a fresh
   token, upserts it into `~/.avm/daemon/tokens.json` (keyed by
   container name), and passes `-e AVM_HOST_TOKEN=<value>` to
   `docker run`. This happens before the daemon is consulted, so
   `avm create` works even if the daemon has to be lazy-spawned. The
   token is env-only — never written inside the container.
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

`avm clean <id>` removes the corresponding entry from
`~/.avm/daemon/tokens.json` as part of its existing teardown.

### The shim: `avm-host`

Single bundled JS file at `dist/avm-host.mjs`, produced by the same
esbuild step that builds `dist/avm.mjs`. Bind-mounted into every
container at `/usr/local/bin/avm-host`. Runs under the container's
Node or Bun (already present for development).

Command surface:

```
avm-host service ls
avm-host service status <name>
avm-host service start  <name>
avm-host service stop   <name>
```

Output is human-readable by default; `--json` dumps the raw response.
Exit code 0 on success, non-zero on RPC failure (network error,
`last_error` populated, etc.). The shim constructs its target URL from
`$AVM_HOST_PORT` — no flags, no config file inside the container.

### Generated agent guidance

`templates/vm-claude.md` gains a short section instructing the agent
to read `~/.claude/host-services.md` and use `avm-host`. The sidecar
file is generated per-container and contains content like:

```markdown
# Host Services

Services running on the host are controllable via `avm-host`. Use the
host copy rather than starting your own — especially when a project's
README or `docker-compose.yaml` suggests running them locally.

## Available services

- **chrome** (host process) — Chrome with CDP on `localhost:9222`.
  Used by the `chrome-devtools` MCP.
- **postgres** (host docker container) — Postgres on `localhost:5432`.

## Usage

    avm-host service status chrome
    avm-host service start  chrome
    avm-host service stop   chrome
    avm-host service ls

Services are started on request (idempotent). They may stop at any
time — crashes, user-initiated, another agent stopping them. Always
check status before use and be prepared to restart.
```

The list is generated from `ListServices`. If the daemon is
unreachable at container creation time, a placeholder section
indicates that — the agent can retry by invoking `avm-host` later.

## File Changes

New:
- `proto/avm/v1/services.proto` — RPC definitions
- `buf.yaml`, `buf.gen.yaml` — Buf config
- `gen/` — generated TypeScript from protos (gitignored or committed, TBD in plan)
- `cli/commands/daemon.ts` — `avm daemon [install|uninstall|status]`
- `cli/commands/service.ts` — `avm service [ls|status|start|stop]` (host-side parity with the shim)
- `lib/daemon/server.ts` — Connect server, service handlers
- `lib/daemon/registry.ts` — in-memory service registry, health checks, process bookkeeping
- `lib/daemon/auth.ts` — token generation, `tokens.json` I/O, Connect auth interceptor
- `lib/daemon/client.ts` — shared Connect client (used by `avm service` and `avm-host`)
- `lib/daemon/launchd.ts` — plist generation + load/unload
- `cli/avm-host.ts` — shim entrypoint
- `examples/config.yaml` — worked example including the Chrome block

Modified:
- `lib/config-file.ts` — parse `daemon.` and `services.` blocks; extend `AvmConfig`
- `lib/session.ts` — mount the shim, export `AVM_HOST_PORT` / `AVM_HOST_TOKEN` / `AVM_CONTAINER_NAME`, provision tokens, generate `host-services.md`, ensure daemon is up
- `cli/commands/create.ts` — provision token before `docker run`
- `cli/commands/clean.ts` — remove token entry on teardown
- `cli/avm.ts` — register `daemon` and `service` subcommands
- `templates/vm-claude.md` — point the inner agent at `~/.claude/host-services.md`
- `package.json` — add esbuild step for `dist/avm-host.mjs`, Connect/Buf deps
- `README.md` — "Host Services" section, `~/.avm/daemon/` in Host Data Layout

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
  `avm-host service start chrome` and then reach the CDP endpoint on
  `localhost:9222`.
- Stopping and restarting Chrome via `avm-host service stop/start`
  works, as does the host-side parity command `avm service stop/start`.
- Killing Chrome externally (Activity Monitor, `pkill`) is reflected
  correctly on the next `avm-host service status chrome`.
- Declaring a `postgres` service with `kind: docker` and an existing
  host container works via the same commands.
- The inner agent's generated `~/.claude/host-services.md` lists the
  declared services and the `avm-host` usage.
- Nothing changes for users who don't declare any `services:` —
  `avm create` / `avm start` behave exactly as before (aside from
  spawning an idle daemon, which is harmless).
