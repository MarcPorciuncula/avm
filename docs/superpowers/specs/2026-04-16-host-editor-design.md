# Host Editor Invocation — Design

Date: 2026-04-16
Status: Draft
Depends on: `2026-04-16-host-services-design.md`

## Problem

When the user asks the in-avm agent to "open this file in my editor,"
the agent can't do it. The editor (`cursor` / `code`) is on the host,
not inside the container, and the sandbox has no access to the host
binary. The user ends up copy-pasting the path into their terminal
and opening it themselves — breaking flow, and defeating the point of
directing the agent in the first place.

The file path is only meaningful inside the container. The editor has
to be launched in remote-SSH mode, pointed at the corresponding avm
container, and handed that in-container path. `avm ssh-config` already
provides the SSH remote (`ssh avm-<id>` works when installed), so the
mechanical pieces exist — what's missing is a way for the agent,
acting on the user's instruction, to *request* the editor open.

## Goals

- Inner-container action: `avm-bridge editor open <path>` (with optional
  line/column) triggers `cursor --remote ssh-remote+avm-<id> <path>`
  (or the `code` equivalent) on the host.
- Per-container identity: the daemon, not the caller, determines which
  remote SSH target to use. A container cannot open files "as" another
  container.
- Reuse the host daemon, avm-bridge, proto surface, auth, and
  versioned API delivered by the host-services spec. This is a new
  RPC, not a new component.

## Non-Goals

- No editor process management. We launch and forget; the editor window
  handles its own lifecycle.
- No inverse direction (host → container file picker, or "pull this
  file out into a host editor"). Editor always opens on the host,
  connected to the container via remote SSH.
- No support for editors other than Cursor and VS Code in v1. The
  daemon reads the existing `editor` top-level field in
  `~/.avm/config.yaml` (already `code | cursor`). Other editors can
  be added later.
- No argument composition (workspace files, multi-file sessions). First
  slice is a single path with optional line/column. Extensions later.

## Prerequisites

This spec assumes the host-services infrastructure is already in place:

- `avm daemon` running (launchd agent or lazy-spawned).
- `avm-bridge` installed in every container.
- `$AVM_HOST_PORT`, `$AVM_HOST_TOKEN`, `$AVM_CONTAINER_NAME` exported
  into containers by `avm create`.
- Connect auth interceptor already attaches `container_name` to
  request context.
- `avm ssh-config` installed by the user (so `avm-<id>` resolves as an
  SSH host on the machine).

The editor feature adds nothing to container creation — it only adds a
new RPC, a new `avm-bridge` subcommand, and a new daemon handler.

## RPC

Add a sibling service alongside `ServicesService` in the `avm.bridge.v1`
proto package. This is a bridge API — called by avm-bridge with
container token auth.

```proto
// proto/avm/bridge/v1/editor.proto
syntax = "proto3";
package avm.bridge.v1;

service EditorService {
  rpc OpenFile(OpenFileRequest) returns (OpenFileResponse);
}

message OpenFileRequest {
  string path = 1;      // absolute path inside the container
  int32  line = 2;      // optional, 1-based; 0 means unset
  int32  column = 3;    // optional, 1-based; 0 means unset
  string editor = 4;    // optional override: "cursor" | "code"; empty = config default
}

message OpenFileResponse {
  string editor = 1;    // which editor was invoked
  string ssh_host = 2;  // e.g. "avm-abcde"
  string command = 3;   // exact argv (for debugging / logs)
}
```

Semantics:

- `path` must be absolute. Relative paths are resolved by
  `avm-bridge` against `$PWD` before sending. Rationale:
  the daemon shouldn't guess which working directory the caller
  intended.
- `line` / `column` map to the editor's `--goto` / `-g` convention
  (`<path>:<line>:<col>`).
- `editor` is an optional override. If empty, the daemon uses
  `config.editor` (existing field, defaults to nothing — in which case
  the RPC errors with `FailedPrecondition`).
- Invocation is fire-and-forget on the host side (`spawn` + detach).
  The response is returned as soon as the host command has been
  launched. Editor errors surface as editor UI, not via this RPC.

## Daemon behavior

`OpenFile`:

1. Read `container_name` from the authenticated request context
   (populated by the auth interceptor from the bearer token).
2. Resolve the editor: request override → `config.editor` → error.
3. Validate the editor binary exists on `PATH` (`which cursor` /
   `which code`). If not, return `FailedPrecondition` with a message
   pointing the user at the install-shell-command step of the editor.
4. Build the argv:

   ```
   <editor> --remote ssh-remote+<container_name> --goto <path>:<line>:<col>
   ```

   (`--goto` omitted if line/column are unset.) `<container_name>` is
   something like `avm-abcde`.
5. **Validate SSH config.** Check that `~/.ssh/config` includes the
   avm SSH config (e.g. parse for `Include ~/.avm/ssh_config` or
   check that `avm-<container_name>` resolves as a known host via
   `ssh -G avm-<container_name>`). If the SSH config is missing,
   return `FailedPrecondition` with a message like:
   "avm SSH config is not installed. The user needs to run
   `avm ssh-config install` on the host."
6. Spawn detached, return the argv in `command` for observability.

## `avm-bridge` (in-container CLI)

New subcommand tree:

```
avm-bridge editor open <path> [--line <n>] [--column <n>] [--editor cursor|code]
```

Behavior:

- Resolve `<path>` to an absolute path using the current CWD. Pass it
  through unchanged if already absolute.
- Send `OpenFile` with the resolved path + optional line/column.
- Print a concise one-line confirmation on success (e.g.
  `opened cursor on ssh-remote+avm-abcde`), exit 0.
- On RPC failure, print the error and exit non-zero. `FailedPrecondition`
  errors (missing editor binary, unconfigured editor) print the
  daemon's message verbatim so the user sees the actionable remediation.

Shorthand: `avm-bridge open <path>` could alias `editor open`. Not in v1;
keep the tree explicit.

## Agent awareness

Extend the generated `~/.claude/host-services.md` sidecar produced by
the host-services spec with a second section:

```markdown
## Opening files on the host

When the user asks you to open a file in their editor, use
`avm-bridge editor open`. The daemon connects the editor to this
container via remote SSH — you do not need to configure anything.

    avm-bridge editor open /home/agent/work/my-repo/src/foo.ts
    avm-bridge editor open /home/agent/work/my-repo/src/foo.ts --line 42
    avm-bridge editor open /home/agent/work/my-repo/src/foo.ts --line 42 --column 10

Only invoke this when the user has asked for it. Do not auto-open
files you happen to be editing.
```

`templates/vm-claude.md` already (via the host-services spec) tells
the agent to consult `~/.claude/host-services.md`, so no further
change is needed there.

## Config

No new top-level keys. Reuses the existing `editor` field in
`~/.avm/config.yaml`:

```yaml
editor: cursor    # or "code"
```

If the field is unset and `avm-bridge` omits `--editor`, the RPC returns
`FailedPrecondition` with "configure `editor:` in ~/.avm/config.yaml
or pass --editor."

## File Changes

New:
- `proto/avm/bridge/v1/editor.proto` — `avm.bridge.v1.EditorService`
- `packages/avm-daemon/src/editor.ts` — `OpenFile` handler

Modified:
- `packages/avm-daemon/src/server.ts` — register `EditorService`
- `packages/avm-bridge/src/cli/commands/editor.ts` — add `editor open` subcommand
- `packages/avm/src/lib/session.ts` — extend the generated `host-services.md` template
  with the editor section
- `README.md` — brief mention under the Host Services section

No changes to `packages/avm/src/cli/commands/create.ts` — container
env vars already set by the host-services spec are sufficient.

## Open Questions / Implementation Notes

- **`--goto` vs `:<line>:<col>` syntax.** Both Cursor and VS Code
  accept `--goto <file>:<line>:<col>`. We'll use that uniformly. If a
  future editor doesn't, the per-editor argv composition will move
  into a small strategy table inside `lib/daemon/editor.ts`.
- **Tilde expansion.** `avm-bridge` resolves `~` relative to the container
  user's home before sending. The daemon does not expand `~` — all
  paths arriving at the daemon are already absolute.
- **Already-open windows.** Cursor/VS Code deduplicate by remote +
  workspace, so repeated calls reuse the existing window. No extra
  logic needed from us.
- **`avm ssh-config` not installed.** The daemon validates this
  before launching the editor and returns `FailedPrecondition` with
  actionable guidance. See step 5 in Daemon behavior.

## Success Criteria

- From inside a container: `avm-bridge editor open /home/agent/.bashrc`
  opens `.bashrc` in the user's configured editor, connected via
  remote SSH to that container.
- Line/column arguments position the cursor correctly.
- Calling `OpenFile` without `AVM_HOST_TOKEN` (unauthenticated) is
  rejected at the auth interceptor.
- A container's `OpenFile` request cannot cause the editor to open as
  if connected to a different container — the daemon ignores any
  caller-supplied container hint and uses the token-resolved identity
  only.
