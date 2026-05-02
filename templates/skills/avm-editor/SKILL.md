---
name: avm-editor
description: Use when the user asks to open a file in their editor. Must be consulted before invoking avm-bridge editor.
---

# Opening files in the user's editor

Use `avm-bridge editor open` to open a file on the user's host editor
(Cursor, VS Code, or Zed) attached to this container. Cursor and VS Code
attach via the Dev Containers attached-container URI; Zed attaches over
SSH.

## Usage

```
avm-bridge editor open <path>
avm-bridge editor open <path> --line 42
avm-bridge editor open <path> --line 42 --column 10
```

Relative paths are resolved against your current working directory.

## When to use

Only when the user explicitly asks you to open a file in their editor.
Do not auto-open files you happen to be editing.

## Error handling

The daemon validates that the editor binary is installed on the host
before launching. If the command fails:

- **"No editor configured"** — the user needs to set `editor:` in
  `~/.avm/config.yaml` on the host, or pass `--editor cursor|code|zed`.
- **"not installed or not in PATH"** — the editor's CLI integration
  needs to be installed on the host (Cursor: Command Palette →
  "Install 'cursor' command", VS Code: similar).

Both are host-side setup steps. Report the error to the user so they
can fix it.
