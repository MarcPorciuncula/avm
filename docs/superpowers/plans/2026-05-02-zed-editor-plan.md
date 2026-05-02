# Zed Editor Support — Implementation Plan

Spec: docs/superpowers/specs/2026-05-02-zed-editor-design.md

## Task 1: Widen editor config schema to accept "zed"

- [x] Status

### Result

Added `"zed"` to `EditorChoice` and `VALID_EDITORS` in
`packages/avm/src/lib/config-file.ts`, and a third
`{ value: "zed", label: "Zed", cli: "zed" }` entry in the `EDITORS`
array in `packages/avm/src/lib/editor.ts`. `pnpm -w build` succeeded.
Commit: a8e18195997886ccdb962c9cbc2b1f56500139fb

### Scope

Extend the config-file schema and the host-CLI editor list to recognize
`zed` as a valid value for `editor:`. After this task, `~/.avm/config.yaml`
with `editor: zed` parses without error and `avm editor` will offer
`Zed` in the picker (when the `zed` binary is available). No actual
launch behavior changes yet — `openInEditor` still produces the
VS Code / Cursor argv, so picking `zed` will fail at the spawn step.
That's fine; Task 2 fixes it.

### Approach

In `packages/avm/src/lib/config-file.ts`:

- Change `export type EditorChoice = "code" | "cursor"` to
  `export type EditorChoice = "code" | "cursor" | "zed"`.
- Change `const VALID_EDITORS = new Set<string>(["code", "cursor"])` to
  `const VALID_EDITORS = new Set<string>(["code", "cursor", "zed"])`.
- Update the `parseEditor` error message — it interpolates
  `[...VALID_EDITORS].join(", ")`, so it picks up the new value
  automatically. No change needed there.

In `packages/avm/src/lib/editor.ts`:

- Add `{ value: "zed", label: "Zed", cli: "zed" }` as a third entry in
  the `EDITORS` array.

### Files

- packages/avm/src/lib/config-file.ts (modify)
- packages/avm/src/lib/editor.ts (modify — `EDITORS` array only)

### Done criteria

- `editor: zed` in `~/.avm/config.yaml` parses without throwing.
- `avm editor <id>` with `zed` installed and no `editor:` set in config
  shows `Zed` as a third option in the `@clack/prompts` picker.
- `avm editor <id>` with `editor: zed` and `zed` on PATH proceeds past
  `resolveEditorCli` (it will still fail at the spawn step until
  Task 2; that is expected).
- TypeScript compiles (`pnpm -w build`).

## Task 2: Per-brand workspace argv in host CLI

- [x] Status

### Result

Refactored `openInEditor` in `packages/avm/src/lib/editor.ts` to
delegate argv construction to a new `buildWorkspaceArgv` helper. The
zed branch returns `["zed", "ssh://<vm>/home/agent/work"]`; code and
cursor continue to use the attached-container `--folder-uri` form.
`pnpm -w build` succeeded.
Commit: 621fe286f2c84f45e62bdabcb3f45ba08c880ece

### Scope

Refactor `openInEditor` in `packages/avm/src/lib/editor.ts` so it
dispatches to a per-brand argv builder. After this task, `avm editor <id>`
with `editor: zed` opens Zed connected to the container over SSH and
shows `~/work` as the workspace.

This task only touches the host-CLI surface (`avm editor`). The bridge /
daemon path is Task 3.

### Approach

In `packages/avm/src/lib/editor.ts`, replace the existing
`openInEditor` body with a dispatcher and add an internal
`buildWorkspaceArgv` helper:

```ts
export function openInEditor(cli: string, vmName: string): void {
  const argv = buildWorkspaceArgv(cli, vmName);
  console.log(`==> Opening ${vmName} in ${cli}...`);
  spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
}

function buildWorkspaceArgv(cli: string, vmName: string): string[] {
  if (cli === "zed") {
    return ["zed", `ssh://${vmName}/home/agent/work`];
  }
  // code / cursor: Dev Containers attached-container URI
  const hexName = Buffer.from(vmName).toString("hex");
  const uri = `vscode-remote://attached-container+${hexName}/home/agent/work`;
  return [cli, "--folder-uri", uri];
}
```

The Zed branch relies on `~/.ssh/config` already including
`~/.avm/ssh_config` (i.e. `avm ssh-config install` has been run). If it
hasn't, `zed ssh://avm-<id>/...` will fail at SSH-connect time — Zed
will surface its own error. We do not pre-validate ssh config on the
host CLI side; the daemon's `buildSshRemoteAuthority` is the canonical
gate, and it runs on the bridge path. Adding a duplicate check here
would be defense-in-depth without a clear motivating failure mode.

The `resolveEditorCli` flow already validates that the binary exists
on PATH before this function is called, so no extra validation is
needed.

### Files

- packages/avm/src/lib/editor.ts (modify — `openInEditor` + new
  `buildWorkspaceArgv`)

### Done criteria

- `avm editor <id>` with `editor: zed` and `zed` installed launches
  Zed; Zed connects to the container over SSH and opens `~/work` as
  the project root. Verified manually by running it.
- `avm editor <id>` with `editor: code` and `editor: cursor` continues
  to launch via the attached-container URI exactly as before. Verified
  manually.
- TypeScript compiles.

## Task 3: Per-brand file argv in daemon, drop OpenFileMode

- [ ] Status
Depends on: Task 1

### Scope

Refactor `packages/avm-daemon/src/editor.ts` so file-open dispatches to
a per-brand argv builder, add `zed` to the resolver allowlist, and
remove the now-irrelevant `OpenFileMode` / `DEFAULT_MODE` machinery.
After this task, `avm-bridge editor open <file>[:L:C]` from inside the
container opens the file in Zed on the host when `editor: zed` is
configured.

### Approach

Edits to `packages/avm-daemon/src/editor.ts`:

1. **Remove `OpenFileMode`, `DEFAULT_MODE`, and the `mode` parameter
   on `openFile`.** No caller passes a non-default value (the bridge
   never threads transport through), and Zed only has one transport.
   The function signature becomes:
   ```ts
   export function openFile(
     containerName: string,
     req: { path: string; line: number; column: number; editor: string },
   ): { editor: string; remoteAuthority: string; command: string }
   ```
   `server.ts` calls `openFile(containerName, req)` — drop the third
   argument if any was passed (none is, today).

2. **Extend the `resolveEditor` allowlist.** Change the check
   `editorName !== "cursor" && editorName !== "code"` to
   `editorName !== "cursor" && editorName !== "code" && editorName !== "zed"`.
   Update the error message to list all three.

3. **Add a per-brand argv builder.** Replace the body of `openFile`
   (after `validateEditorBinary`) with:
   ```ts
   const { argv, remoteAuthority } = buildFileArgv(editorName, containerName, req);

   const child = spawn(argv[0], argv.slice(1), {
     detached: true,
     stdio: "ignore",
   });
   child.unref();

   return {
     editor: editorName,
     remoteAuthority,
     command: argv.join(" "),
   };
   ```
   Where `buildFileArgv` is a new internal function:
   ```ts
   function buildFileArgv(
     editorName: string,
     containerName: string,
     req: { path: string; line: number; column: number },
   ): { argv: string[]; remoteAuthority: string } {
     if (editorName === "zed") {
       const remoteAuthority = buildSshRemoteAuthority(containerName);
       let target = `ssh://${containerName}${req.path}`;
       if (req.line > 0) {
         target += `:${req.line}`;
         if (req.column > 0) target += `:${req.column}`;
       }
       return { argv: ["zed", target], remoteAuthority };
     }

     // code / cursor: attached-container URI
     const remoteAuthority = buildAttachedContainerAuthority(containerName);
     const argv = [editorName, "--remote", remoteAuthority, req.path];
     if (req.line > 0) {
       let gotoTarget = `${req.path}:${req.line}`;
       if (req.column > 0) gotoTarget += `:${req.column}`;
       argv.push("--goto", gotoTarget);
     }
     return { argv, remoteAuthority };
   }
   ```

4. **Keep `buildAttachedContainerAuthority` and `buildSshRemoteAuthority`
   as-is.** Both are still used: code/cursor path uses the first, zed
   path uses the second. The zed branch in `buildFileArgv` calls
   `buildSshRemoteAuthority(containerName)`, which preserves the
   existing `FailedPrecondition` "avm SSH config is not installed"
   error path when `avm ssh-config install` hasn't been run. The
   "ssh-remote fallback" branch of the old code (which was only
   reachable by setting `mode: "ssh-remote"` from a hypothetical
   caller that never existed) is removed implicitly.

5. **Precondition on `req.path`.** It is already absolute by the time
   the daemon sees it: the bridge runs `resolve(args.path)` in
   `packages/avm-bridge/src/cli/commands/editor.ts:48` before sending
   the RPC. The zed branch's `ssh://${containerName}${req.path}`
   template literal relies on this leading slash to produce a
   well-formed URI like `ssh://avm-abcde/home/agent/work/foo.ts`. No
   additional normalization is needed in the daemon.

### Files

- packages/avm-daemon/src/editor.ts (modify)

`packages/avm-daemon/src/server.ts` does not need modification —
verified its call site is `openFile(containerName, { path, line, column, editor })`,
two args only.

### Done criteria

- From inside an avm container: `avm-bridge editor open ~/work/foo.ts --line 42 --column 5`
  with `editor: zed` opens Zed on the host with `foo.ts` at line 42,
  column 5. Verified manually.
- Same command with `--line 42` (no column) opens at line 42.
  Verified manually.
- Same command with no `--line` opens the file with no cursor jump.
  Verified manually.
- Same command with `editor: code` and `editor: cursor` continues to
  use the attached-container URI exactly as before. Verified manually.
- With `editor: zed` set but `avm ssh-config install` not run, the
  daemon returns the existing `FailedPrecondition` SSH-config error.
  Verified manually by temporarily uninstalling the include line.
- With `editor: zed` set but `zed` not on PATH, the daemon returns the
  existing `FailedPrecondition` "binary not found" error. Verified
  manually by renaming the `zed` symlink.
- TypeScript compiles.

## Task 4: Update README, examples, and skill

- [ ] Status
Depends on: Task 3

### Scope

Document Zed as a supported editor in user-facing surfaces. Three
locations: README's "Editor integration" section, `examples/config.yaml`,
and the host-side avm skill's editor guidance.

### Approach

**`README.md`** — Two edits:

1. **Editor integration section.** Update the paragraph that reads:

   > This launches the editor (configured via `editor:` in `~/.avm/config.yaml`)
   > in remote-SSH mode, connected to the requesting container. Requires
   > `avm ssh-config install`.

   Replace with a version that:
   - Lists supported editors as `code`, `cursor`, `zed`.
   - Notes that `code`/`cursor` use the Dev Containers attached-container
     protocol and don't require `avm ssh-config install`, while `zed`
     uses SSH and does.

2. **Commands list.** Add `avm editor <id>` to the Commands code block
   near the top of the README (verified absent today; the command
   exists but isn't listed there).

**`examples/config.yaml`** — Replace the existing line 3 comment
`# Editor for remote-SSH editor connections` (which is misleading —
`code`/`cursor` don't use SSH) with a comment that lists the three
allowed values and notes the SSH prerequisite for Zed. Suggested form:

```
# Editor used by `avm editor` and `avm-bridge editor open`.
# Allowed: code | cursor | zed.  zed requires `avm ssh-config install`.
```

Keep the existing example value (`editor: cursor`) — no behavior change.

**`skills/avm/SKILL.md`** — Single-file skill (verified: no sub-files
under `skills/avm/`). Update line 64's command-list comment from:

```
avm editor [id]           # Open a container in VS Code / Cursor (auto-detects, saves preference)
```

to mention Zed as a third option, and note the SSH prerequisite for Zed
near the editor-choice discussion. The other VS Code / Cursor mentions
in the skill (around lines 156 and 167) are about remote-SSH client
behavior, not editor selection — leave those unchanged.

### Files

- README.md (modify — Editor integration section + Commands list)
- examples/config.yaml (modify — replace stale `editor:` comment)
- skills/avm/SKILL.md (modify — line 64 only)

### Done criteria

- README's "Editor integration" section names all three editors and
  notes the SSH prerequisite for Zed.
- `examples/config.yaml` documents `zed` as an allowed `editor:` value.
- The avm skill mentions Zed alongside code and cursor where editor
  choice is discussed.
- A user reading these surfaces understands that picking `zed` requires
  `avm ssh-config install`, and that `code`/`cursor` do not.
