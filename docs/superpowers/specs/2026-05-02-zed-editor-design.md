# Zed Editor Support — Design Spec

Date: 2026-05-02

## Problem

avm currently supports VS Code and Cursor as the user's host editor, in
two surfaces:

1. **Host CLI** — `avm editor <id>` opens a container's `~/work` as a
   workspace via the Dev Containers attached-container URI.
2. **Bridge** — `avm-bridge editor open <file>[:<line>:<col>]` from
   inside the container opens a single file in the user's host editor
   via the daemon's `EditorService.openFile` RPC.

Both flows depend on the VS Code / Cursor CLI shape: hex-encoded
attached-container authority, `--folder-uri`, `--remote`, `--goto`. Zed
has no equivalent of this protocol — there is no `attached-container+...`
URI and no `zed://docker/<id>` scheme. Users who prefer Zed cannot use
either surface today.

## Goals

- Add `zed` as a third option for the `editor:` field in
  `~/.avm/config.yaml`, alongside `code` and `cursor`.
- Make both existing surfaces (host `avm editor`, bridge
  `avm-bridge editor open`) work with Zed selected.
- Preserve current behavior for `code` and `cursor` exactly.

## Non-goals

- Supporting Zed's own dev-container mode (`zed --dev-container`,
  `dev_container_connections[]`). It would clash with avm owning
  container lifecycle, and the dev-container schema is documented as
  unstable.
- Changing the `EditorService` proto. The current request shape
  (`path`, `line`, `column`, `editor`) is sufficient.
- Changing the inner-agent guidance in `templates/vm-claude.md`. The
  agent's instruction is brand-agnostic ("open this file in the user's
  editor") — only the host-side adapter changes.

## Background — what Zed supports

Zed (as of v0.218, January 2026) supports three remote modes: SSH, Dev
Containers (via `docker exec` over stdio), and WSL. Of these:

- **SSH** is stable, has a documented one-shot CLI form
  (`zed ssh://user@host:port/path`), reads `~/.ssh/config`, and
  supports positional `:line:col` suffixes on path arguments.
- **Dev Containers** require either `zed --dev-container <path>` (which
  invokes `devcontainer up` — clashes with avm) or a pre-registered
  entry in `dev_container_connections[]` plus a UI click in the Remote
  Projects picker (no programmatic launch). Schema is "still in
  development" per Zed's own docs.

avm already has SSH as a first-class concept: `avm ssh-config install`
writes an `Include ~/.avm/ssh_config` line into `~/.ssh/config`, and
the daemon's existing editor module already has an `ssh-remote` mode.
Reusing that infrastructure for Zed is the natural fit.

## Architecture

```
                    ┌──────────────────────────────────────┐
                    │            HOST (user's mac)         │
                    │                                      │
   user types       │   ┌──────────────┐                   │
   `avm editor <id>`├──▶│  avm CLI     │                   │
                    │   │  commands/   │                   │
                    │   │  editor.ts   │                   │
                    │   └──────┬───────┘                   │
                    │          │                           │
                    │          ▼                           │
                    │   ┌──────────────┐                   │
                    │   │ lib/editor.ts│                   │
                    │   │ (per-brand   │── spawnSync ─────▶│── zed/code/cursor
                    │   │  adapter)    │                   │
                    │   └──────────────┘                   │
                    │                                      │
                    │   ┌──────────────┐                   │
                    │   │  avm-daemon  │                   │
                    │   │  editor.ts   │── spawn detached ▶│── zed/code/cursor
                    │   │  (per-brand  │                   │
                    │   │   adapter)   │                   │
                    │   └──────▲───────┘                   │
                    │          │ Connect RPC               │
                    └──────────┼───────────────────────────┘
                               │
                    ┌──────────┼───────────────────────────┐
                    │          │   CONTAINER (avm-<id>)    │
                    │   ┌──────┴───────┐                   │
                    │   │ avm-bridge   │                   │
                    │   │ editor open  │                   │
                    │   │ <file>[:L:C] │                   │
                    │   └──────────────┘                   │
                    └──────────────────────────────────────┘
```

No new components. No new RPCs. No new container-side dependencies.
Two adapter functions per editor brand, in two existing files, plus a
config schema widening.

## Components

### Editor brand adapter

Each editor brand exposes two functions:

```
build_workspace_argv(container_name) -> string[]
   // host-side, used by `avm editor <id>` to open ~/work as a workspace

build_file_argv(container_name, path, line, column) -> string[]
   // daemon-side, used by `EditorService.openFile`
```

Three adapters: `code`, `cursor`, `zed`. `code` and `cursor` are
structurally identical (only the binary name differs). `zed` is
distinct.

Selection happens after `resolveEditor` returns the brand name. Per-brand
adapters mean each branch is self-contained, transport choice lives with
the brand that needs it, and the now-irrelevant `OpenFileMode` parameter
on the daemon's `openFile` is removed.

### Argv shapes

| Surface | code / cursor | zed |
|---|---|---|
| Host workspace | `code --folder-uri vscode-remote://attached-container+<hex>/home/agent/work` | `zed ssh://avm-<id>/home/agent/work` |
| Daemon file (line+col) | `code --remote attached-container+<hex> <path> --goto <path>:<L>:<C>` | `zed ssh://avm-<id>/<path>:<L>:<C>` |
| Daemon file (line only) | `code --remote attached-container+<hex> <path> --goto <path>:<L>` | `zed ssh://avm-<id>/<path>:<L>` |
| Daemon file (no line) | `code --remote attached-container+<hex> <path>` | `zed ssh://avm-<id>/<path>` |

The `avm-<id>` host is what `avm ssh-config install` already configures.
Zed reads `~/.ssh/config`, so `ssh://avm-<id>/...` resolves identically
to `ssh avm-<id>`.

### Config schema (`lib/config-file.ts`)

```
EditorChoice = "code" | "cursor" | "zed"
VALID_EDITORS = { "code", "cursor", "zed" }
```

The `EDITORS` constant in `lib/editor.ts` gains
`{ value: "zed", label: "Zed", cli: "zed" }`. The existing
`resolveEditorCli` flow already handles N options (single-available
auto-selects, multi-available prompts via `@clack/prompts`).

### Host CLI adapter (`packages/avm/src/lib/editor.ts`)

`openInEditor(cli, vmName)` becomes a dispatcher that picks the per-brand
adapter and spawns its argv:

```ts
function openInEditor(cli: string, vmName: string): void {
  const argv = buildWorkspaceArgv(cli, vmName);
  spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
}

function buildWorkspaceArgv(cli: string, vmName: string): string[] {
  if (cli === "zed") {
    return ["zed", `ssh://${vmName}/home/agent/work`];
  }
  // code / cursor — existing attached-container path
  const hex = Buffer.from(vmName).toString("hex");
  return [cli, "--folder-uri", `vscode-remote://attached-container+${hex}/home/agent/work`];
}
```

### Daemon adapter (`packages/avm-daemon/src/editor.ts`)

The `OpenFileMode` parameter and `DEFAULT_MODE` constant are removed.
`openFile` resolves the editor brand, dispatches to the per-brand argv
builder, and spawns:

```ts
export function openFile(
  containerName: string,
  req: { path: string; line: number; column: number; editor: string },
): { editor: string; remoteAuthority: string; command: string } {
  const editorName = resolveEditor(req.editor);
  validateEditorBinary(editorName);

  const { argv, remoteAuthority } = buildFileArgv(editorName, containerName, req);

  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore" });
  child.unref();

  return { editor: editorName, remoteAuthority, command: argv.join(" ") };
}
```

`buildFileArgv` branches on editor name:

- `code` / `cursor` → attached-container authority, `--remote`,
  `--goto path:line[:col]` if line > 0.
- `zed` → ssh-remote authority (validates ssh config via existing
  `buildSshRemoteAuthority`), positional argument
  `ssh://<container>/<path>` with `:L` or `:L:C` suffix when
  `line > 0`.

Both branches return the argv plus the `remoteAuthority` string for the
RPC response.

`resolveEditor`'s allowlist gains `zed`. `validateEditorBinary` works
unchanged (`which zed`).

### Bridge (`packages/avm-bridge/src/cli/commands/editor.ts`)

No change. The bridge already forwards `path`, `line`, `column`, and
optional `editor` to the daemon — all the brand-specific work happens
on the host.

## Error handling

No new error categories. All paths reuse existing `ConnectError` codes:

- `FailedPrecondition` — editor binary missing, or (for any ssh-using
  path) ssh config not installed.
- `InvalidArgument` — unknown editor brand.

For Zed specifically, every flow goes through `buildSshRemoteAuthority`,
so the existing "avm SSH config is not installed. Run
`avm ssh-config install`" message applies.

## Testing approach

Per CLAUDE.md, no automated tests. Manual end-to-end after
implementation:

1. `editor: zed` in config → `avm editor <id>` opens Zed at `~/work`.
2. From inside container: `avm-bridge editor open ~/work/foo.ts --line 42 --column 5`
   opens Zed on the host with `foo.ts` at 42:5.
3. Same flows with `editor: code` and `editor: cursor` to confirm no
   regression in the existing attached-container behavior.
4. `editor: zed` but `zed` not on PATH → clear error message.
5. `editor: zed` but `avm ssh-config install` not run → clear error
   message pointing to the install command.

## Files

- `packages/avm/src/lib/config-file.ts` — extend `EditorChoice` and
  `VALID_EDITORS`.
- `packages/avm/src/lib/editor.ts` — add `zed` to `EDITORS`; refactor
  `openInEditor` to dispatch per-brand workspace argv.
- `packages/avm-daemon/src/editor.ts` — remove `OpenFileMode` parameter,
  add `zed` to `resolveEditor` allowlist, dispatch per-brand file argv.
- `examples/config.yaml` — note `editor: zed` as an option.
- `README.md` — "Editor integration" section mentions Zed; the
  config-key reference adds `zed` to the `editor:` allowed values.
- `skills/avm/...` — editor skill mentions Zed alongside code/cursor.
- `templates/vm-claude.md` — unchanged.

## Alternatives considered

- **Synthesize `.devcontainer/devcontainer.json` and launch
  `zed --dev-container <path>`.** Rejected: Zed runs `devcontainer up`,
  which would conflict with avm-managed container lifecycle.
- **Pre-register `dev_container_connections[]` in Zed's settings.json.**
  Rejected: no documented CLI for "open this connection now" — requires
  a UI click, doesn't cover the bridge file-link flow at all (no
  by-id URI in Zed), and the schema is documented as unstable.
- **Keep `OpenFileMode` parameter on `openFile`.** Rejected: it has
  always been hardcoded to `attached-container` by `DEFAULT_MODE`,
  never threaded through from the bridge RPC. Per-editor transport is
  the cleaner shape now that brands diverge.
