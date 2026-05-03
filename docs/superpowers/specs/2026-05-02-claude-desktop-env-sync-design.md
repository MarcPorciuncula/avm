# Register avm containers as Claude desktop SSH environments

**Status:** design approved
**Date:** 2026-05-02

## Problem

The Claude desktop app supports SSH environments — a "remote machine you
manage" the user picks from the environment dropdown when starting a session.
Per the official docs ([code.claude.com/docs/en/desktop](https://code.claude.com/docs/en/desktop)),
these are stored as a `sshConfigs` array in `~/.claude/settings.json` (and a
managed-settings file for org admins). Connections added via the in-app dialog
land in the user file.

avm already publishes containers as SSH-reachable hosts (`avm ssh-config`
maintains `~/.avm/ssh_config` with one `Host avm-<id>` block per container,
optionally Included from `~/.ssh/config`). The missing piece is making those
containers appear in the desktop app's environment dropdown so the user can
attach a desktop session to a container with one click — without manually
re-typing each `avm-<id>` into the GUI every time a container is created.

This spec adds an opt-in sync that mirrors avm containers into
`~/.claude/settings.json` `sshConfigs`, lifecycle-bound to the existing
`avm ssh-config install`/`uninstall` commands.

## Goals

- Every avm container with an SSH port assigned appears as an SSH environment
  in the Claude desktop app, identified as `avm-<id>`.
- Sync runs at the same call sites as `syncSshConfig()` today
  (`avm create`, `avm clean`, `avm ssh-config sync`), gated on a state flag.
- Install / uninstall lifecycle is driven through the existing
  `avm ssh-config install` / `avm ssh-config uninstall` commands, with a
  separate prompt and a separate state flag from the SSH-config Include.
- `~/.claude/settings.json` writes are non-destructive: only entries the avm
  CLI owns are touched; all other top-level keys and all non-avm `sshConfigs`
  entries are preserved verbatim.
- The integration is a no-op until the user explicitly opts in. Users who
  never open the desktop app are unaffected.

## Non-goals (v1)

- **Detecting whether the desktop app is installed.** We write the file even
  if the desktop app is absent; entries are inert in that case. Simpler than
  probing for the app and matches the desktop app's own behaviour (it writes
  the same file unconditionally).
- **Managed-settings file (`/Library/Application Support/...`).** Decided
  against in design — requires sudo, conflicts with corp-deployed managed
  settings, heavier than warranted.
- **Self-contained entries** (`sshHost: agent@localhost`, port-per-entry).
  Decided against in design — the desktop schema can't disable strict host
  checking, so first-connect to a fresh container would prompt about
  `localhost:<port>`. Resolving through the SSH config alias (`avm-<id>`)
  inherits the `StrictHostKeyChecking no` / `UserKnownHostsFile /dev/null`
  already set in the avm-managed SSH config.
- **Automatic SSH-config install when desktop is enabled.** The two flags are
  independent. We rely on the user to run `avm ssh-config install` once,
  which our prompts encourage. Without it, desktop entries reference an alias
  SSH won't resolve, and the desktop app's first-connect attempt will fail
  loudly — that's the right failure mode (visible, fixable with one command).
- **Watching `~/.claude/settings.json` for external changes.** No file
  watcher; we re-converge on the next avm command.
- **Per-container customization** of `name`, `startDirectory`, etc. v1 ships
  fixed values. Future config block can layer on if needed.
- **Showing `outdated` or `status` in the dropdown name.** The desktop UI has
  no concept of "stopped" SSH environments; we list all avm containers
  (running and stopped). The desktop app handles connect failures itself.

## Architecture

```
                                                       host
                                       ┌─────────────────────────────────────────┐
                                       │                                         │
                                       │  ~/.avm/ssh_config (existing)           │
                                       │     Host avm-k7xf2                      │
                                       │       HostName localhost                │
                                       │       Port 22001                        │
                                       │       StrictHostKeyChecking no          │
                                       │       UserKnownHostsFile /dev/null      │
                                       │                                         │
                                       │  ~/.ssh/config (existing)               │
                                       │     Include ~/.avm/ssh_config           │
                                       │                                         │
                                       │  ~/.claude/settings.json (NEW write)    │
                                       │     {                                   │
                                       │       "sshConfigs": [                   │
                                       │         {                               │
                                       │           "id":            "avm-k7xf2", │
                                       │           "name":          "avm-k7xf2", │
                                       │           "sshHost":       "avm-k7xf2", │
                                       │           "startDirectory":"~/work"    │
                                       │         }                               │
                                       │       ]                                 │
                                       │     }                                   │
                                       │                                         │
                                       └─────────────────────────────────────────┘
                                                       ▲                ▲
                                                       │                │
        ┌────────── triggers ──────────┐               │                │
        │ avm create                   │               │                │
        │ avm clean                    │ ─── syncHostIntegrations() ────┘
        │ avm ssh-config sync          │   (always syncs ~/.avm/ssh_config;
        │ avm ssh-config install       │    syncs settings.json iff
        │                              │    state.desktopConfig.installPrompt
        └──────────────────────────────┘    === "installed")
```

The desktop entry's `sshHost: "avm-<id>"` resolves through `~/.ssh/config`
which Includes `~/.avm/ssh_config`. SSH options from that block (port,
`StrictHostKeyChecking`, `UserKnownHostsFile`, `User agent`) all apply
transparently, so the desktop app's spawned SSH process Just Works without
any per-entry options the desktop schema doesn't support.

## Components

### State (`packages/avm/src/lib/state.ts`)

Extend `AvmState` with a new top-level subsection mirroring `sshConfig`:

```ts
export interface AvmState {
  sshConfig?: {
    installPrompt?: "installed" | "declined";
  };
  desktopConfig?: {
    /** Set when the user has answered the desktop-config first-run prompt. */
    installPrompt?: "installed" | "declined";
  };
  notifications?: {
    installPrompt?: "installed" | "declined";
  };
}
```

`updateState`'s shallow-merge already supports new top-level subsections
without changes.

### Desktop config module (`packages/avm/src/lib/desktop-config.ts`)

New module modelled directly on `lib/ssh-config.ts`. Path constant:

```ts
import os from "node:os";
import { join } from "node:path";
const claudeSettingsFile = join(os.homedir(), ".claude", "settings.json");
```

(File path is fixed by the desktop app — no need to make it user-configurable.)

Public surface:

```ts
export interface SshConfigEntry {
  id: string;
  name: string;
  sshHost: string;
  sshPort?: number;
  sshIdentityFile?: string;
  startDirectory?: string;
}

/** Render the desktop SSH-config entry for a single VM, or null if no SSH port. */
export function renderDesktopEntry(vm: VmInfo): SshConfigEntry | null;

/** Re-converge `~/.claude/settings.json` `sshConfigs` with current containers. */
export async function syncDesktopConfig(): Promise<void>;

/** Set the install flag and run an initial sync. Idempotent. */
export async function installDesktopConfig(): Promise<{
  status: "installed" | "already";
}>;

/**
 * Drop avm-* entries from `sshConfigs`, clear the install flag.
 * Leaves the rest of settings.json (other keys, non-avm sshConfigs) intact.
 * Idempotent.
 */
export async function uninstallDesktopConfig(): Promise<{
  status: "uninstalled" | "not-installed";
}>;
```

`renderDesktopEntry` returns `null` for VMs without an `sshPort` (mirrors
`renderManagedFile`'s `if (vm.sshPort == null) continue` rule). Otherwise:

```ts
{
  id: vm.name,           // "avm-k7xf2"
  name: vm.name,         // dropdown label, kept identical to id for v1
  sshHost: vm.name,      // resolves via ~/.ssh/config Include
  startDirectory: "~/work",
}
```

`sshPort`, `sshIdentityFile` are intentionally omitted — they're already
specified in the SSH config block we're aliasing into.

`syncDesktopConfig` algorithm:

1. Read `~/.claude/settings.json`. If missing → start from `{}`. If the file
   exists but JSON.parse fails → throw with the path; refuse to write.
2. Validate top-level shape: must be a plain object, and if `sshConfigs` is
   present it must be an array (otherwise throw). All other keys are passed
   through opaquely.
3. List avm VMs (`listAvmVms()`).
4. Build the new `sshConfigs` array: existing entries that don't match the
   ownership rule, followed by freshly rendered avm entries (skipping VMs
   without `sshPort`). If the resulting array is empty, set the key to `[]`
   rather than removing it (it's harmless and avoids JSON-formatting churn).
5. Serialize with `JSON.stringify(next, null, 2) + "\n"`. Atomic write
   (`<path>.tmp` → `rename`). File mode `0o600`. `mkdir -p ~/.claude/` if the
   directory is missing.

`installDesktopConfig`:

1. `updateState({ desktopConfig: { installPrompt: "installed" } })`.
2. `await syncDesktopConfig()`.
3. Return `{ status: "installed" }` if the flag was previously not
   `"installed"`, else `{ status: "already" }`.

`uninstallDesktopConfig`:

1. Read settings.json. If missing or no avm-owned entries are present →
   return `{ status: "not-installed" }` (still clear the flag).
2. Filter out avm-owned entries; preserve everything else verbatim. Atomic
   write only if any entry was dropped.
3. `updateState({ desktopConfig: { installPrompt: undefined } })` —
   so a future `install` (or `create`-time prompt) re-asks.
4. Return `{ status: "uninstalled" }` if anything was dropped, else
   `{ status: "not-installed" }`.

### Ownership rule

An entry in `sshConfigs` is "avm-owned" iff its `id` is a string matching
the regex `^avm-[a-z0-9]{5}$` — exactly the format `generateSessionName()`
produces (`packages/avm/src/lib/vm.ts:50`). User-named containers passed to
`avm create <name>` go through `normalizeVmName` which guarantees the
`avm-` prefix; the `[a-z0-9]{5}` shape is generator-specific, but extending
the regex to `^avm-` alone risks collision with a user-handwritten entry
that legitimately starts with `avm-`. Strict generator-shape matching
sidesteps that.

For user-named containers (`avm create my-feature` → `avm-my-feature`),
v1 simply doesn't sync them to the desktop app. v1 ownership recognition
covers only the auto-generated form. Future iterations can store an
explicit allowlist in `state.json` if user-named container support is
needed; deferring keeps v1 simple and prevents accidental clobbering of
user-authored `sshConfigs` entries.

> Update during decomposition: this is a real limitation. v1 ships with
> auto-generated names only; user-named containers (`avm create foo`) do
> not appear in the desktop dropdown. Documented in README and noted in
> the prompt copy. If this hurts in practice, a follow-up adds an
> ownership marker (`{"_avm": true}` or similar) so we can track any
> generated-by-avm entry.

### Sync wiring (`packages/avm/src/lib/ssh-config.ts` → new helper)

Add a wrapper to centralise the "sync everything host-side" pattern:

```ts
/** Run all host-integration syncs. Always runs ssh-config; runs desktop-config when installed. */
export async function syncHostIntegrations(): Promise<void> {
  await syncSshConfig();
  const state = readState();
  if (state.desktopConfig?.installPrompt === "installed") {
    await syncDesktopConfig();
  }
}
```

(Lives in `lib/ssh-config.ts` rather than a new lib so the Connect-style
"facade" stays close to the dominant ssh-config logic. Imports from
`desktop-config.ts` and `state.ts`.)

Replace `await syncSshConfig()` at every existing call site with
`await syncHostIntegrations()`:

- `packages/avm/src/cli/commands/create.ts:114`
- `packages/avm/src/cli/commands/clean.ts:117`

Within `lib/ssh-config.ts` itself the existing `installInclude` calls
`syncSshConfig` — leave that as-is (the install command handles
desktop-config separately, so we don't want a double-sync there).

### CLI surface (`packages/avm/src/cli/commands/ssh-config.ts`)

Extend `installSub` and `uninstallSub`. The existing `syncSub` is a thin
wrapper around `syncSshConfig`; replace it with `syncHostIntegrations` so
`avm ssh-config sync` updates both files in one call.

`installSub` flow:

1. Run the existing `installInclude()` flow (writes `~/.avm/ssh_config`,
   adds the `Include` block to `~/.ssh/config`, sets
   `sshConfig.installPrompt`). Print existing message.
2. Check `state.desktopConfig.installPrompt`. If `undefined`, prompt:

   ```
   ?  Also register avm containers in the Claude desktop app's
      environment dropdown (writes to ~/.claude/settings.json)?
      › Yes, install it
        Not now (ask again next time)
        No, don't ask again
   ```

3. On "yes": `installDesktopConfig()`, log
   `"Registered avm containers in ~/.claude/settings.json (sshConfigs)."`
4. On "never": `updateState({ desktopConfig: { installPrompt: "declined" } })`.
5. On "later" or already-answered: skip.

`installSub` accepts new flags to skip the prompt:

- `--desktop` / `--no-desktop`: if passed, don't prompt; behave as the
  corresponding answer.

`uninstallSub` flow:

1. Existing `uninstallInclude()` (clears `~/.ssh/config` Include, clears
   `sshConfig.installPrompt`).
2. If `state.desktopConfig.installPrompt === "installed"`,
   `uninstallDesktopConfig()` unconditionally — uninstall is total. Log
   `"Removed avm entries from ~/.claude/settings.json."`.
3. If the flag wasn't set, leave the desktop file untouched. Don't run
   `uninstallDesktopConfig()` "just in case" — that risks touching a file
   we never owned.

### Create-time prompt (`packages/avm/src/cli/commands/create.ts`)

The existing prompt asks about installing the SSH-config Include. We extend
the *same* point in the create flow with a *second*, independent prompt for
the desktop-config side.

After the existing SSH-config prompt block (`create.ts:117`–`142`), add a
parallel block:

```ts
const stateAfterSsh = readState();
if (stateAfterSsh.desktopConfig?.installPrompt === undefined) {
  const choice = await select({
    message:
      "Register avm containers in the Claude desktop app's environment dropdown? (writes to ~/.claude/settings.json)",
    options: [
      { value: "yes", label: "Yes, install it" },
      { value: "later", label: "Not now (ask again next time)" },
      { value: "never", label: "No, don't ask again" },
    ],
    initialValue: "yes",
  });
  if (!isCancel(choice)) {
    if (choice === "yes") {
      await installDesktopConfig();
      console.log("Registered avm containers in ~/.claude/settings.json.");
    } else if (choice === "never") {
      updateState({ desktopConfig: { installPrompt: "declined" } });
    }
  }
}
```

If the user answered "later" to the SSH-config prompt, both prompts fire
again on the next `avm create`. If they answered "never" to one, only the
other re-prompts.

### Documentation

- `README.md` — Add a sentence under "Commands" / `avm ssh-config install`
  noting that it also offers to register containers in the Claude desktop
  app's environment dropdown. Add a brief subsection under "Customizing"
  describing the desktop integration, the file written, and the
  user-named-container limitation.
- `templates/vm-claude.md` — **No changes.** This integration is host-side
  only; per the project's "scoped to in-container needs" rule, the inner
  agent's CLAUDE.md doesn't mention it.
- `skills/avm/SKILL.md` — Add a short section noting the
  `avm ssh-config install` flow now handles desktop-config registration too,
  so host-side Claude knows to surface it during first-time setup guidance.

## Data flow

For a fresh user opting in for the first time:

1. User runs `avm create`. `syncHostIntegrations()` → `syncSshConfig()`
   writes `~/.avm/ssh_config` with the new container's `Host avm-<id>`
   block. `state.desktopConfig.installPrompt` is `undefined`, so
   `syncDesktopConfig()` is skipped.
2. Create-flow prompts for SSH-config Include. User says yes →
   `~/.ssh/config` gains the `Include` block.
3. Create-flow prompts for desktop-config. User says yes →
   `installDesktopConfig()` runs, which sets the flag and runs
   `syncDesktopConfig()`. `~/.claude/settings.json` gains a `sshConfigs`
   array with one entry (`avm-<id>`).
4. User runs `avm create` again. Both prompts are answered, so they don't
   re-fire. `syncHostIntegrations()` runs both syncs; the new container
   appears in both files.
5. User opens Claude desktop, clicks the environment dropdown — the avm
   container is listed alongside Local/Remote.
6. User runs `avm clean <id>`. `syncHostIntegrations()` removes the
   container's block from both files.

For a user who declines desktop integration:

1. Create-flow runs `syncSshConfig()` only. `~/.claude/settings.json` is
   never touched, regardless of how many containers exist or are cleaned.
2. They can change their mind later via `avm ssh-config install --desktop`
   (or by uninstalling, which clears the flag, then re-installing to get
   re-prompted).

## Edge cases

| Case | Behaviour |
|---|---|
| `~/.claude/settings.json` is missing | Sync creates `~/.claude/` if needed and writes a fresh file with just `sshConfigs`. |
| File exists but is malformed JSON | Sync throws with the path and a remediation hint; never overwrites. |
| Top-level value is an array or non-object | Same as malformed: throw, don't overwrite. |
| `sshConfigs` exists but is not an array | Same: throw, don't overwrite. |
| User has hand-edited an `avm-*` entry in `sshConfigs` | Next sync overwrites the avm-* entry (we own it). Other keys and non-avm `sshConfigs` entries are preserved. |
| User has a non-avm `sshConfigs` entry whose id doesn't match `^avm-[a-z0-9]{5}$` | Preserved verbatim across all syncs. |
| User has a hand-added entry whose id happens to match `^avm-[a-z0-9]{5}$` | Treated as avm-owned and overwritten on next sync — accepted. The 5-char generator space is large; collision with user-authored ids is extremely unlikely, and the rule is documented. |
| User-named container (`avm create my-feature` → `avm-my-feature`) | Not synced to desktop in v1 (id doesn't match strict regex). Documented limitation. |
| User edits `~/.claude/settings.json` while desktop app is running | No locking; last-writer-wins. The desktop app re-reads on session start; any race is benign because both writers append valid JSON atomically. |
| Concurrent avm processes both run sync | No locking. Atomic rename guarantees the file is never half-written; both writers compute the same target state, so order doesn't matter. |
| `avm ssh-config uninstall` while desktop flag is `"declined"` | Don't touch settings.json. Don't clear the desktop flag. The two flags are independent. |
| User installs desktop, then cleans every container | `sshConfigs: []` (or absent if the only entries were avm-owned). User stays opted-in; flag remains `"installed"`. |
| First `avm create` on a brand-new machine, both prompts | Two prompts in sequence. User can press enter twice to accept both. State is remembered, so this only happens once. |
| User says "no, don't ask again" to one prompt and "yes" to the other | Both states recorded independently; no further prompts on either side. |
| Sync fails with EACCES/EROFS on `~/.claude/settings.json` | Throw a clear error from the sync function. In `create.ts`/`clean.ts` call sites, a sync failure is fatal to the command — same as the existing `syncSshConfig()` behaviour. |

## Out-of-scope (deferred)

Listed under "Non-goals (v1)" above. The most likely follow-ups:

- **Ownership marker for arbitrary container ids.** A `_avm: true` field on
  each owned entry, persisted alongside the `id`-regex check, would let us
  track user-named containers safely. Defer until users hit the limitation.
- **Per-container customization.** A `desktop:` block in `~/.avm/config.yaml`
  with overrides for `name` and `startDirectory` per container or globally.
- **Managed-settings file** support for org admins distributing avm to
  teams. Real but unrelated to the individual user's workflow this spec
  targets.

## Open questions

None at design time.
