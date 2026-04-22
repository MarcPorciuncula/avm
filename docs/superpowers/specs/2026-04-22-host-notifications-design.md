# Host notifications from in-container Claude hooks

**Status:** design approved
**Date:** 2026-04-22

## Problem

The user wants the same "Claude needs you" / "Claude is done" sound + macOS
notification feedback they get on their host setup, but for Claude Code agents
running inside avm containers. The container is sandboxed and has no host
access (no `osascript`, no `afplay`), so the in-container hook needs a path to
reach the host.

avm already has the right pieces in place: avm-bridge (in-container CLI) and
avm-daemon (host control plane) talk over Connect RPC with per-container
auth. The natural design is to extend that channel.

## Goals

- In-container Claude Code hooks dispatch host-side sound + macOS notification
  via avm-bridge → avm-daemon, with no per-container plumbing.
- Notifications cover both "agent needs the user's attention" (permission
  prompts, interview questions, idle waits) and "agent finished a turn".
- Hook installation into the container's Claude settings is non-destructive,
  idempotent, easy to uninstall, and identifiable for future cleanup.
- Daemon-side master switch lets the user mute notifications without
  uninstalling hooks.
- Host CLI commands manage install state and mute state.
- Notification body identifies the source container (and, when available, the
  in-container working directory) so the user can tell which agent pinged
  them.

## Non-goals (v1)

- **Foreground/focus suppression.** Earlier evaluation showed accurate
  detection across tmux, ssh, terminal tabs, and OrbStack/Docker process
  layouts is unreliable. Defer; rely on macOS Focus modes for now.
- **Per-container muting.** Master switch is global. A future
  `notifications.mutedContainers: [name1, ...]` field can layer on without
  changing the proto.
- **Per-event-kind enable/disable.** Single master switch. Future addition.
- **Click-to-focus on the macOS notification.** Same hard problem as focus
  detection.
- **Sound throttling/coalescing.** macOS Notification Center coalesces
  visually; afplay is fine to overlap.
- **Custom title/body per call.** Daemon owns message text.
- **Linux/Windows host support.** avm is macOS-only today.

## Architecture

```
                                          host
┌────────────────── container ────────────────────────┐    ┌──────────────────────────┐
│                                                     │    │                          │
│  Claude Code                                        │    │  avm-daemon              │
│    │                                                │    │    NotificationService   │
│    │ Notification / Stop hook fires                 │    │      ├─ auth (token →    │
│    ▼                                                │    │      │   container)     │
│  /usr/local/bin/avm-bridge claude-hook <event>      │    │      ├─ master switch   │
│    │                                                │    │      ├─ resolve sound  │
│    │ reads stdin JSON (cwd, session_id)            │    │      ├─ build msg      │
│    │ maps event name → NotificationKind            │    │      ├─ afplay        │
│    │ Connect RPC: Notify(kind, cwd?, ...)          │ ──▶│      └─ osascript      │
│    │ swallows transport errors, exits 0            │    │                          │
└─────────────────────────────────────────────────────┘    └──────────────────────────┘
```

The hook is a one-liner. Bridge does the JSON parsing of the Claude hook
payload and forwards just the fields the daemon cares about. Daemon owns all
sound/message/format mapping, so changing what the user sees never requires
touching `~/.avm/system/claude/settings.json`.

## Components

### Bridge proto (`proto/avm/bridge/v1/notification.proto`)

```proto
syntax = "proto3";
package avm.bridge.v1;

service NotificationService {
  rpc Notify(NotifyRequest) returns (NotifyResponse);
}

enum NotificationKind {
  NOTIFICATION_KIND_UNSPECIFIED     = 0;
  NOTIFICATION_KIND_NEEDS_ATTENTION = 1;  // Claude `Notification` hook
  NOTIFICATION_KIND_COMPLETE        = 2;  // Claude `Stop` hook
}

message NotifyRequest {
  NotificationKind kind = 1;
  optional string cwd = 2;        // in-container working dir, if available
  optional string session_id = 3; // Claude session id, future use
}

message NotifyResponse {}
```

Generated bundle ships alongside existing bridge protos. No new transport, no
new auth. Adding a new kind later = add an enum value + daemon mapping +
bridge subarg; old hooks keep working.

### avm-bridge command (`packages/avm-bridge/src/cli/commands/claude-hook.ts`)

Subcommand: `avm-bridge claude-hook <event-name>`, where `<event-name>` is
the literal lowercased Claude Code hook event name. v1 supports
`notification` and `stop`; the surface is open to more events later
(`subagent-stop`, `user-prompt-submit`, etc.) without changing the daemon
proto.

Behaviour:

1. Attempt to read stdin and parse it as JSON (Claude hook payload). Extract
   `cwd` and `session_id` if present. Failure to read or parse is silent —
   call proceeds without those fields.
2. Map `<event-name>` to a `NotificationKind`:
   - `notification` → `NEEDS_ATTENTION`
   - `stop` → `COMPLETE`
   - unknown → log to stderr and exit 0 (silent no-op).
3. Issue Connect RPC `NotificationService.Notify(...)` against the daemon
   using the existing per-container Bearer token.
4. **Always exit 0** — wrap the RPC in a try/catch that logs to stderr and
   swallows the error. Hook failures must not surface to Claude or the user.

**Why `claude-hook`, not `notify`.** The `claude-hook` namespace is honest
about the surface: it's an adapter for Claude Code hook events, with
Claude-specific concerns (stdin payload schema, event-name vocabulary). The
`notify` namespace is reserved for a future generic notification API
(`avm-bridge notify --kind needs-attention --title ... --body ...`) that
non-Claude in-container tools (build scripts, watchers) could call directly.
Keeping the two namespaces separate means the user-managed `settings.json`
stays a thin event pass-through, and the daemon proto remains a generic
notification surface that doesn't know anything about Claude.

### avm-daemon handler (`packages/avm-daemon/src/services/notifications.ts`)

On `Notify(req)`:

1. **Auth.** Reuse existing Bearer middleware. Resolve token → container
   record. Unknown token → `UNAUTHENTICATED`.
2. **Master switch.** Re-read `~/.avm/config.yaml` (cheap). If
   `notifications.enabled === false`, return `OK` — silent no-op. Daemon must
   never error back for "muted".
3. **Sound mapping.** Resolve `notifications.sounds[<kind>]` (defaults below).
   If a user-supplied file path doesn't exist, fall back to default and log a
   warning once per (kind, daemon-lifetime).
4. **Build message.**
   - Title: `"AVM — <container-name>"`
   - Body line 1: `"Claude needs your attention"` for `needs-attention`,
     `"Claude completed its work"` for `complete`.
   - Body line 2 (only if `req.cwd` present): `formatLocation(cwd)`, which
     returns `<basename(parent)>/<basename(cwd)>` (mirrors the user's
     existing host hook).
5. **Dispatch** in parallel, fire-and-forget:
   - `afplay -v <volume> <file>` — detached child
   - `osascript -e 'display notification "<body>" with title "<title>"'`
6. Return `OK` without waiting on the subprocesses.

**Platform guard.** At daemon startup, if `process.platform !== 'darwin'`,
register a stub handler that logs once and returns `OK` without dispatching.

**Concurrency.** No locking, no throttling. Two concurrent Stops from two
containers each notify; macOS handles the rest.

### Host CLI (`packages/avm/src/cli/commands/notify.ts`)

Citty `defineCommand` mirroring the existing command shapes:

- `avm notify install` — idempotent. Calls into `lib/notify-hooks.ts` to
  load `~/.avm/system/claude/settings.json` (creates `{}` if absent), strip
  any existing entries whose `command` starts with `avm-bridge claude-hook `,
  then append fresh entries (see below). Sets
  `notifications.install: true` and `notifications.prompted: true` in
  `config.yaml`.
- `avm notify uninstall` — same load/strip, no re-add. Sets
  `notifications.install: false`. Leaves `prompted: true`.
- `avm notify status` — prints: hooks installed (yes/no, count of matching
  entries), daemon `notifications.enabled`, current sound mapping, prompted
  state.
- `avm notify mute` / `avm notify unmute` — convenience for setting
  `notifications.enabled` to `false`/`true`. Doesn't touch `settings.json`.

### Hook entries written

Two entries appended (mirrors the user's host setup, but with `Notification`
in place of `PermissionRequest` so we cover elicitations and idles too):

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "avm-bridge claude-hook notification" }]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "avm-bridge claude-hook stop" }]
      }
    ]
  }
}
```

Bridge binary is on `$PATH` in the container per
`session.ts:236` (mounted at `/usr/local/bin/avm-bridge`), so no path
interpolation needed.

### Hook installer logic (`packages/avm/src/lib/notify-hooks.ts`)

Pure module. Two exported functions:

```ts
export function installHooks(settings: SettingsJson): SettingsJson;
export function uninstallHooks(settings: SettingsJson): SettingsJson;
```

Both return a new object (don't mutate input). Both:

- Touch only `hooks.Notification` and `hooks.Stop` arrays. All other top-level
  keys, all other hook events, and all unrelated entries inside those arrays
  are preserved verbatim.
- Within those arrays, identify "AVM entries" as entries where every
  `hooks[].command` starts with the literal prefix `avm-bridge claude-hook `.
  Strip those before any append.
- After install, both arrays end with the canonical AVM entry above.

The host CLI command handles file IO (load with `JSON.parse`, write with
`JSON.stringify(..., 2)` + trailing newline). If the file is unparseable,
abort with a clear error and remediation hint — never overwrite.

### Configuration (`~/.avm/config.yaml`)

New top-level `notifications` block. All fields optional; daemon and CLI fill
defaults at read time:

```yaml
notifications:
  enabled: true                # daemon master switch (default true)
  prompted: false              # set true once user has been asked
  install: true                # informational: did host CLI install hooks?
  sounds:
    needs-attention:
      file: /System/Library/Sounds/Ping.aiff
      volume: 0.7
    complete:
      file: /System/Library/Sounds/Submarine.aiff
      volume: 1.0
```

Daemon re-reads on every `Notify` call (small file, cheap). No SIGHUP
needed; toggling `enabled` or editing sounds takes effect immediately.

### First-run prompt

Fires from:

- **`avm provision`** — always runs after image build, *unless*
  `notifications.prompted === true`.
- **`avm start`** — fallback, runs only if `notifications.prompted` is unset.

Single `@clack/prompts` confirm:

```
?  AVM can play a sound and post a macOS notification when the agent
   needs your attention or finishes a turn. Install hooks now?
   You can change this later with `avm notify {install,uninstall,mute,unmute}`.
   › Yes / No
```

- Yes → run install logic (as `avm notify install`).
- No → set `prompted: true, install: false`, no further changes.

To re-prompt after answering No, the user runs the explicit command or
clears `notifications.prompted` in `config.yaml`.

## Data flow

For a single Stop event in container `myproj`, in-container Claude cwd
`/home/agent/work/alcova-backend/feature-x`:

1. Claude Code fires the `Stop` hook, executes
   `avm-bridge claude-hook stop` with hook payload JSON on stdin.
2. Bridge reads stdin, parses JSON, extracts
   `cwd = "/home/agent/work/alcova-backend/feature-x"`.
3. Bridge maps `stop` → `NotificationKind.COMPLETE`.
4. Bridge issues `NotificationService.Notify(kind=COMPLETE, cwd=...)` over
   Connect RPC with the container's Bearer token.
5. Daemon authenticates → container `myproj`.
6. Daemon reads `notifications.enabled === true` from `config.yaml`.
7. Daemon resolves `notifications.sounds.complete` → defaults
   (`Submarine.aiff @ 1.0`).
8. Daemon builds:
   - Title: `AVM — myproj`
   - Body: `Claude completed its work\nalcova-backend/feature-x`
9. Daemon dispatches `afplay` and `osascript` in parallel, returns `OK`.
10. Bridge exits 0; Claude continues unaffected.

## Edge cases

| Case | Behaviour |
|---|---|
| Daemon not running when hook fires | Bridge RPC fails, error logged to stderr, bridge exits 0. Claude unaffected. |
| `settings.json` is malformed JSON | `install`/`uninstall` aborts with parse error + hint; never overwrites. |
| `settings.json` missing | `install` creates `{ hooks: { Notification: [...], Stop: [...] } }`. |
| User-supplied sound file missing on disk | Daemon falls back to default and logs once per (kind, daemon-lifetime). |
| Daemon on non-darwin host | Notify handler logs once at startup, returns OK without dispatching. |
| Outdated bridge binary sends unknown kind | Daemon returns `INVALID_ARGUMENT`; bridge swallows; silent. |
| Hook stdin not piped / not JSON | Bridge proceeds without `cwd`; daemon omits the location line. |
| Two simultaneous notifications | Both dispatch. macOS Notification Center coalesces visually; afplay overlap is fine. |
| User answered No to first-run prompt | Both `provision` and `start` skip the prompt forever (until `prompted` flag cleared). |

## Out-of-scope (deferred)

See "Non-goals (v1)" above for the explicit list.

## Open questions

None at design time. All decisions captured above.
