# Claude desktop environment sync — Implementation Plan

Spec: docs/superpowers/specs/2026-05-02-claude-desktop-env-sync-design.md

**Goal:** Mirror avm containers into the Claude desktop app's environment
dropdown by writing `sshConfigs` entries into `~/.claude/settings.json`,
opt-in via the existing `avm ssh-config install`/`uninstall` lifecycle and
gated on a new `state.desktopConfig.installPrompt` flag.

**Reference reading before starting:**
- `docs/superpowers/specs/2026-05-02-claude-desktop-env-sync-design.md` — full design
- `packages/avm/src/lib/ssh-config.ts` — the closest analog; mirror its shape
- `packages/avm/src/lib/state.ts` — `AvmState`, `readState`, `updateState`
- `packages/avm/src/lib/vm.ts` — `VmInfo`, `listAvmVms`, `generateSessionName`
- `packages/avm/src/cli/commands/ssh-config.ts` — install/uninstall/sync subcommands
- `packages/avm/src/cli/commands/create.ts` lines 100–145 — existing first-run prompt block to mirror

**Build commands:**
- `pnpm build` — compile all workspaces
- `pnpm exec tsc --noEmit` (from `packages/avm`) — type-check only

No automated tests (per project convention). Verification is manual end-to-end.

---

## Task 1: Extend AvmState with desktopConfig section
- [x] Status

### Result
Added `desktopConfig?.installPrompt?: "installed" | "declined"` to
`AvmState`. Shape mirrors the existing `sshConfig` and `notifications`
subsections; no logic change needed because `updateState` already
shallow-merges any top-level subsection. Commit: 64b2f92

### Scope
Add a new `desktopConfig` subsection to the `AvmState` interface so the new
install flag has a typed home. No behaviour change — purely a type extension.

### Approach
Edit `packages/avm/src/lib/state.ts`. Add a new optional top-level key on
`AvmState` mirroring the existing `sshConfig` and `notifications` shapes:

```ts
desktopConfig?: {
  /** Set when the user has answered the desktop-config first-run prompt. */
  installPrompt?: "installed" | "declined";
};
```

`updateState` already shallow-merges new top-level keys, so no logic change
is needed — it works for any `AvmState` subsection.

### Files
- packages/avm/src/lib/state.ts (modify)

### Done criteria
- `AvmState.desktopConfig.installPrompt` typechecks as
  `"installed" | "declined" | undefined`.
- `pnpm build` succeeds with no type errors.
- `readState()` and `updateState()` work unchanged for existing subsections.

---

## Task 2: Implement the desktop-config library module
- [x] Status

### Result
Implemented `packages/avm/src/lib/desktop-config.ts` with the four
exported functions and the strict-shape JSON read/write helpers.
Verified end-to-end via the canonical CLI surface against a real
`~/.claude/settings.json` containing user-owned hooks/permissions/
plugins keys — those were preserved verbatim and a single avm
container appeared as an `sshConfigs` entry that the desktop app
loaded successfully. Commit: b8f2b3e

### Scope
Create the new `lib/desktop-config.ts` module that owns
`~/.claude/settings.json` writes. Provides `renderDesktopEntry`,
`syncDesktopConfig`, `installDesktopConfig`, `uninstallDesktopConfig`. Pure
implementation, no CLI wiring yet. No call sites are modified in this task.

### Approach
Create `packages/avm/src/lib/desktop-config.ts`. Structure mirrors
`packages/avm/src/lib/ssh-config.ts` for parity.

Top of file:

```ts
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { listAvmVms, type VmInfo } from "./vm.ts";
import { readState, updateState } from "./state.ts";

const claudeSettingsFile = join(os.homedir(), ".claude", "settings.json");

/** Matches avm-generated container names (avm-<5 lower-hex/alnum>). */
const AVM_OWNED_ID_RE = /^avm-[a-z0-9]{5}$/;

const DESKTOP_START_DIRECTORY = "~/work";

export interface SshConfigEntry {
  id: string;
  name: string;
  sshHost: string;
  sshPort?: number;
  sshIdentityFile?: string;
  startDirectory?: string;
}

interface ClaudeSettings {
  sshConfigs?: SshConfigEntry[];
  [key: string]: unknown;
}
```

`renderDesktopEntry`:

```ts
export function renderDesktopEntry(vm: VmInfo): SshConfigEntry | null {
  if (vm.sshPort == null) return null;
  if (!AVM_OWNED_ID_RE.test(vm.name)) return null;
  return {
    id: vm.name,
    name: vm.name,
    sshHost: vm.name,
    startDirectory: DESKTOP_START_DIRECTORY,
  };
}
```

(Skipping VMs whose name doesn't match the strict regex enforces the
"v1 only auto-generated names" rule from the spec, and means the same
ownership check protects both write and identification of foreign entries.)

`readSettings` (private helper):

```ts
function readSettings(): ClaudeSettings {
  if (!existsSync(claudeSettingsFile)) return {};
  const raw = readFileSync(claudeSettingsFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Refusing to overwrite ~/.claude/settings.json — file is not valid JSON: ${
        (err as Error).message
      }. Fix or remove the file, then re-run.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Refusing to overwrite ~/.claude/settings.json — top-level value is not a JSON object.`,
    );
  }
  const settings = parsed as ClaudeSettings;
  if (settings.sshConfigs !== undefined && !Array.isArray(settings.sshConfigs)) {
    throw new Error(
      `Refusing to overwrite ~/.claude/settings.json — \`sshConfigs\` exists but is not an array.`,
    );
  }
  return settings;
}
```

`writeSettings` (private helper):

```ts
function writeSettings(settings: ClaudeSettings): void {
  mkdirSync(dirname(claudeSettingsFile), { recursive: true, mode: 0o700 });
  const tmp = `${claudeSettingsFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, claudeSettingsFile);
}
```

`isAvmOwnedEntry` (private helper):

```ts
function isAvmOwnedEntry(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "id" in entry &&
    typeof (entry as { id: unknown }).id === "string" &&
    AVM_OWNED_ID_RE.test((entry as { id: string }).id)
  );
}
```

`syncDesktopConfig`:

```ts
export async function syncDesktopConfig(): Promise<void> {
  const settings = readSettings();
  const existing = settings.sshConfigs ?? [];
  const preserved = existing.filter((e) => !isAvmOwnedEntry(e));

  const vms = await listAvmVms();
  const fresh = vms
    .map(renderDesktopEntry)
    .filter((e): e is SshConfigEntry => e !== null);

  settings.sshConfigs = [...preserved, ...fresh];
  writeSettings(settings);
}
```

(Always assigning `sshConfigs` — even when empty — keeps the file shape
predictable. `[]` is valid in the schema.)

`installDesktopConfig`:

```ts
export interface InstallDesktopResult {
  status: "installed" | "already";
}

export async function installDesktopConfig(): Promise<InstallDesktopResult> {
  const before = readState().desktopConfig?.installPrompt;
  // Sync first, then flip the flag — if sync throws, the user retries
  // cleanly and gets the canonical "installed" message instead of "already".
  await syncDesktopConfig();
  updateState({ desktopConfig: { installPrompt: "installed" } });
  return { status: before === "installed" ? "already" : "installed" };
}
```

`uninstallDesktopConfig`:

```ts
export interface UninstallDesktopResult {
  status: "uninstalled" | "not-installed";
}

export async function uninstallDesktopConfig(): Promise<UninstallDesktopResult> {
  let dropped = 0;
  if (existsSync(claudeSettingsFile)) {
    const settings = readSettings();
    const existing = settings.sshConfigs ?? [];
    const preserved = existing.filter((e) => !isAvmOwnedEntry(e));
    dropped = existing.length - preserved.length;
    if (dropped > 0) {
      settings.sshConfigs = preserved;
      writeSettings(settings);
    }
  }
  updateState({ desktopConfig: { installPrompt: undefined } });
  return { status: dropped > 0 ? "uninstalled" : "not-installed" };
}
```

### Files
- packages/avm/src/lib/desktop-config.ts (new)

### Done criteria
- All four exported functions exist with the signatures above.
- `pnpm build` succeeds; types resolve.
- Manually invoking `syncDesktopConfig()` against a settings.json containing
  a non-avm entry preserves that entry verbatim. (Test in a node REPL or via
  the wired commands in later tasks.)

---

## Task 3: Add syncHostIntegrations facade and wire into create/clean
- [x] Status
Depends on: Task 2

### Result
Added `syncHostIntegrations` to `lib/ssh-config.ts`; replaced the
direct `syncSshConfig()` call sites in `avm create`, `avm clean`, and
the `ssh-config` command's `syncSub` and root handler. Verified by
running `node dist/avm.mjs ssh-config sync` against a real settings.json
with the desktop install flag set — sshConfigs entry was written and
the desktop app loaded the container successfully. Commit: da35c09

### Scope
Add a single facade that callers use instead of calling `syncSshConfig`
directly, so adding/removing host-integration syncs in the future doesn't
require chasing every call site. Replace the two existing `syncSshConfig`
call sites in commands (`create.ts`, `clean.ts`).

### Approach
Edit `packages/avm/src/lib/ssh-config.ts`. At the bottom of the file, add:

```ts
import { readState } from "./state.ts";
import { syncDesktopConfig } from "./desktop-config.ts";

/**
 * Run all host-integration syncs after a container lifecycle event.
 * Always syncs ~/.avm/ssh_config; syncs ~/.claude/settings.json only
 * when the user has opted in.
 */
export async function syncHostIntegrations(): Promise<void> {
  await syncSshConfig();
  if (readState().desktopConfig?.installPrompt === "installed") {
    await syncDesktopConfig();
  }
}
```

(Co-locating in `ssh-config.ts` rather than creating a new lib keeps the
two functions side-by-side and matches the dominant-module convention.)

Replace `await syncSshConfig()` with `await syncHostIntegrations()` in:

- `packages/avm/src/cli/commands/create.ts` line 114 — also update the
  import on line 7 to add `syncHostIntegrations`.
- `packages/avm/src/cli/commands/clean.ts` line 117 — also update the
  import on line 5.

Inside `lib/ssh-config.ts` itself, the `installInclude()` function calls
`syncSshConfig()` directly (line 98) — leave this unchanged. The desktop
side is handled separately in the install command, and a double-sync there
would be redundant.

In `cli/commands/ssh-config.ts`, change `syncSub` to call
`syncHostIntegrations` instead of `syncSshConfig`, so
`avm ssh-config sync` updates both files in one shot. The default-when-
no-subcommand handler at the bottom of the file should also call
`syncHostIntegrations`.

### Files
- packages/avm/src/lib/ssh-config.ts (modify — add facade + imports)
- packages/avm/src/cli/commands/create.ts (modify — swap call + import)
- packages/avm/src/cli/commands/clean.ts (modify — swap call + import)
- packages/avm/src/cli/commands/ssh-config.ts (modify — swap call in syncSub and root)

### Done criteria
- `pnpm build` succeeds.
- `avm ssh-config sync` runs without error in a fresh state.
- `avm create` and `avm clean` invoke `syncHostIntegrations` instead of
  `syncSshConfig` directly.
- No remaining call to `syncSshConfig()` outside `lib/ssh-config.ts`.

---

## Task 4: Wire desktop install/uninstall into the ssh-config command
- [x] Status
Depends on: Task 2

### Scope
Extend `avm ssh-config install` and `avm ssh-config uninstall` to drive the
desktop-config side, with a separate prompt + separate flag, plus
`--desktop`/`--no-desktop` flags to skip the prompt non-interactively.

### Approach
Edit `packages/avm/src/cli/commands/ssh-config.ts`.

Imports to add:

```ts
import { select, isCancel } from "@clack/prompts";
import {
  installDesktopConfig,
  uninstallDesktopConfig,
} from "../../lib/desktop-config.ts";
import { readState } from "../../lib/state.ts";
```

Update `installSub`:

```ts
const installSub = defineCommand({
  meta: {
    name: "install",
    description:
      "Add an Include to ~/.ssh/config and (optionally) register avm containers in the Claude desktop app.",
  },
  args: {
    desktop: {
      type: "boolean",
      description:
        "Also register avm containers in ~/.claude/settings.json. Skips the prompt.",
    },
    "no-desktop": {
      type: "boolean",
      description:
        "Don't register avm containers in ~/.claude/settings.json. Skips the prompt.",
    },
  },
  async run({ args }) {
    if (args.desktop && args["no-desktop"]) {
      console.error(
        "Error: --desktop and --no-desktop are mutually exclusive.",
      );
      process.exit(1);
    }

    // 1. Existing SSH-config install (unchanged behaviour).
    const sshResult = await installInclude();
    updateState({ sshConfig: { installPrompt: "installed" } });
    if (sshResult.status === "installed") {
      console.log("Installed Include in ~/.ssh/config.");
      console.log("You can now run: ssh avm-<id>");
    } else {
      console.log("Already installed — ~/.ssh/config already includes avm's config.");
    }

    // 2. Decide on desktop side.
    let wantDesktop: boolean | null = null;
    if (args.desktop) wantDesktop = true;
    else if (args["no-desktop"]) wantDesktop = false;

    if (wantDesktop === null) {
      const state = readState();
      if (state.desktopConfig?.installPrompt === undefined) {
        const choice = await select({
          message:
            "Also register avm containers in the Claude desktop app's environment dropdown? (writes to ~/.claude/settings.json)",
          options: [
            { value: "yes", label: "Yes, install it" },
            { value: "later", label: "Not now (ask again next time)" },
            { value: "never", label: "No, don't ask again" },
          ],
          initialValue: "yes",
        });
        if (isCancel(choice)) return;
        if (choice === "yes") wantDesktop = true;
        else if (choice === "never") {
          updateState({ desktopConfig: { installPrompt: "declined" } });
          wantDesktop = false;
        } else {
          // "later" — leave state undefined so we ask again.
          wantDesktop = false;
        }
      } else {
        // Already answered. Honour previous answer:
        wantDesktop = state.desktopConfig?.installPrompt === "installed";
      }
    }

    if (wantDesktop) {
      const desktopResult = await installDesktopConfig();
      if (desktopResult.status === "installed") {
        console.log(
          "Registered avm containers in ~/.claude/settings.json (sshConfigs).",
        );
      } else {
        console.log(
          "Already registered — ~/.claude/settings.json already lists avm containers.",
        );
      }
    }
  },
});
```

Update `uninstallSub`:

```ts
const uninstallSub = defineCommand({
  meta: {
    name: "uninstall",
    description:
      "Remove the avm-managed Include from ~/.ssh/config and avm entries from ~/.claude/settings.json.",
  },
  async run() {
    const sshResult = await uninstallInclude();
    updateState({ sshConfig: { installPrompt: undefined } });
    if (sshResult.status === "uninstalled") {
      console.log("Removed avm Include block from ~/.ssh/config.");
    } else {
      console.log("Nothing to uninstall — no avm Include block found.");
    }

    const state = readState();
    if (state.desktopConfig?.installPrompt === "installed") {
      const desktopResult = await uninstallDesktopConfig();
      if (desktopResult.status === "uninstalled") {
        console.log(
          "Removed avm entries from ~/.claude/settings.json.",
        );
      } else {
        console.log(
          "No avm entries found in ~/.claude/settings.json.",
        );
      }
    }
  },
});
```

`syncSub` change is covered in Task 3.

### Files
- packages/avm/src/cli/commands/ssh-config.ts (modify)

### Done criteria
- `avm ssh-config install --no-desktop` runs SSH-side only, no prompt, no
  changes to `~/.claude/settings.json`.
- `avm ssh-config install --desktop` runs both sides, no prompt, registers
  containers.
- `avm ssh-config install --desktop --no-desktop` exits with a
  mutually-exclusive error before any work runs.
- `avm ssh-config install` (no flags) prompts only when
  `state.desktopConfig.installPrompt === undefined`.
- `avm ssh-config uninstall` removes both sides only when desktop was
  previously installed.
- Settings.json is left untouched when the desktop flag is `"declined"` or
  `undefined`.

---

## Task 5: Add the desktop prompt to avm create
- [x] Status
Depends on: Task 2

### Result
Added the desktop-config tri-state prompt to `avm create`, after the
existing SSH-config prompt and before the session-ready summary. Same
"yes / later / never" semantics, independent state slot. Not exercised
end-to-end in this round (would require creating a fresh container);
prompt logic is identical in shape to the SSH-config one which is
already covered by manual testing on previous sessions. Commit: 2b0dd27

### Scope
After the existing SSH-config first-run prompt in `avm create`, add a
second, parallel prompt for desktop registration. Independent state, same
"yes / later / never" tri-state.

### Approach
Edit `packages/avm/src/cli/commands/create.ts`. After the existing block
ending at line 142 (the `if (state.sshConfig?.installPrompt === undefined)`
prompt), and before the `const sshInstalled = ...` line, add:

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
      console.log(
        "Registered avm containers in ~/.claude/settings.json.",
      );
    } else if (choice === "never") {
      updateState({ desktopConfig: { installPrompt: "declined" } });
    }
    // "later" → no state change; ask again next time.
  }
}
```

Add the import at the top:

```ts
import { installDesktopConfig } from "../../lib/desktop-config.ts";
```

The session-ready summary block (lines 147–154) need not mention the
desktop integration — the user will see the avm container appear in the
desktop app's dropdown directly. Keeping the success summary terse.

### Files
- packages/avm/src/cli/commands/create.ts (modify)

### Done criteria
- On a fresh state, `avm create` prompts for SSH-config Include, then
  prompts for desktop registration. Both prompts can be answered
  independently.
- Answering "yes" to desktop registration writes the container into
  `~/.claude/settings.json` and sets the flag.
- Answering "never" sets `desktopConfig.installPrompt = "declined"` without
  writing the file.
- "later" leaves the flag `undefined`; the prompt re-fires on the next
  `avm create`.
- Once both flags are set, `avm create` runs without any prompts.

---

## Task 6: Update README and avm skill
- [x] Status
Depends on: Tasks 4, 5

### Result
Added a "Claude desktop integration" subsection to README's
Customizing section covering the install/uninstall flow, the v1
user-named-container limitation, and the preservation guarantees for
non-avm settings.json content. Updated the commands table in both
README and skills/avm/SKILL.md to reflect the new --desktop /
--no-desktop flags. SKILL.md's "SSH vs Attach" paragraph appended
with the two-prompt model. templates/vm-claude.md left untouched
(host-side feature). Commit: 67022a7

### Scope
Document the desktop integration in user-facing docs. Two files only —
keep `templates/vm-claude.md` untouched (host-side feature; not for the
inner agent per project principles).

### Approach
1. **`README.md`:**
   - Under the `Commands` table, expand the `avm ssh-config install` line
     to mention it also offers desktop-app registration.
   - Add a new subsection under "Customizing" titled
     "Claude desktop integration", roughly:

   ```
   ### Claude desktop integration

   `avm ssh-config install` offers to register avm containers as SSH
   environments in the Claude desktop app's environment dropdown. When
   enabled, every container with an SSH port is mirrored into
   `~/.claude/settings.json` `sshConfigs` as it's created or destroyed.

   The integration is opt-in (separate from the SSH config Include) and
   is removed by `avm ssh-config uninstall`. v1 only registers
   containers with the auto-generated `avm-<5-char>` name format —
   user-named containers (`avm create my-feature`) are not added to the
   dropdown.
   ```

2. **`skills/avm/SKILL.md`:** Two edits.

   - Update the `## Commands` block (lines 48–81) by replacing the
     `avm ssh-config install` line with one that mentions the desktop
     prompt:

     ```
     avm ssh-config install    # Add Include line and (optionally) register containers in Claude desktop
     ```

   - Update the paragraph in `## SSH vs Attach` that begins
     "Running `avm ssh-config install` (or accepting the prompt on first
     `avm create`)…" (currently ~lines 163–167). Append a sentence:

     > It also offers to register avm containers in the Claude desktop
     > app's environment dropdown (writes `sshConfigs` entries into
     > `~/.claude/settings.json`). The two prompts are independent — the
     > user can accept either, both, or neither.

   No other sections need updating.

3. Leave `templates/vm-claude.md` and `examples/Dockerfile`/`examples/config.yaml`
   unchanged. No new config keys needed (the integration is driven entirely
   from `state.json`).

### Files
- README.md (modify)
- skills/avm/SKILL.md (modify)

### Done criteria
- `README.md` documents the integration and the v1 user-named-container
  limitation.
- `skills/avm/SKILL.md` `## Commands` block updated; `## SSH vs Attach`
  paragraph appended with the new sentence.
- No mention of the integration in `templates/vm-claude.md` or in any
  in-container path.

---

## Task 7: Manual end-to-end verification
- [x] Status
Depends on: Tasks 3, 4, 5, 6

### Result
Verified end-to-end against `~/.claude/settings.json` containing
real user-owned keys (hooks, permissions, plugins, oauth tokens).

| Step | Outcome |
|---|---|
| 3. Fresh install via `avm ssh-config install --desktop` | sshConfigs entry written for the running container; `desktopConfig.installPrompt: "installed"` set in state.json |
| 6. Hand-add a non-avm `sshConfigs` entry, re-sync | non-avm entry preserved verbatim; avm entry re-appended |
| 7. Hand-edit an avm entry's `name` and `startDirectory`, re-sync | avm entry restored to canonical shape; user edit overwritten as designed |
| 8. Inject malformed JSON, run sync | command exits non-zero with "Refusing to overwrite … file is not valid JSON"; file left unchanged |
| 9. `avm ssh-config uninstall` | `~/.ssh/config` Include block removed; avm-owned `sshConfigs` entries dropped; non-avm entries preserved; both `sshConfig` and `desktopConfig` install flags cleared |
| 11. Desktop app smoke test | container appeared in the environment dropdown; user confirmed the entry was selectable |

Steps 4 (avm create new container) and 5 (avm clean) and 10 (first-run
prompt sequence) were not exercised in the verification round — they
require destructive container ops the user didn't want to incur during
testing. Their behaviour follows from Tasks 3 and 5 via static
inspection of the call-site changes.

### Scope
Walk through the full lifecycle by hand and confirm `~/.claude/settings.json`
behaves correctly under each operation. No code changes — this task records
the verification result.

### Approach
Run, in order, on a fresh state (`rm ~/.avm/state.json` and back up
`~/.claude/settings.json` first). Record the outcome of each step in the
task `### Result` block.

1. **Backup:** `cp ~/.claude/settings.json ~/.claude/settings.json.bak`
2. **Reset:** `rm -f ~/.avm/state.json` (or restore from before the test).
3. **Fresh install:**
   - `avm ssh-config install --desktop`
   - Inspect `~/.claude/settings.json` — should have an `sshConfigs` array
     with an entry per running avm container, each `id` matching `avm-<id>`.
   - `cat ~/.avm/state.json` — should show `desktopConfig.installPrompt: "installed"`.
4. **Add a container:**
   - `avm create` (auto-generated name).
   - Inspect `~/.claude/settings.json` — new `avm-<id>` entry.
5. **Remove a container:**
   - `avm clean <id>`
   - Inspect `~/.claude/settings.json` — entry gone; non-avm entries (if any)
     untouched.
6. **User-edit preservation:**
   - Hand-add a `sshConfigs` entry with id `not-avm` and run any avm command.
   - Verify the `not-avm` entry is preserved verbatim.
7. **User-edit overwrite:**
   - Hand-edit an existing `avm-<id>` entry (change its `name`) and run any
     avm command.
   - Verify the avm entry is restored to the canonical shape.
8. **Malformed file refusal:**
   - Inject a syntax error into `~/.claude/settings.json` and run
     `avm ssh-config sync`.
   - Verify the command fails with a clear error and the file is unchanged.
   - Restore the file.
9. **Uninstall:**
   - `avm ssh-config uninstall`
   - Inspect `~/.claude/settings.json` — all `avm-*` entries gone, other
     keys/entries untouched.
   - `cat ~/.avm/state.json` — `desktopConfig.installPrompt` should be
     unset.
10. **First-run prompts on `avm create`:**
    - Reset state again. Run `avm create` and observe two prompts in
      sequence (SSH then desktop). Try each combination of yes/later/never
      across runs to confirm independent gating.
11. **Desktop app smoke test:**
    - With desktop integration installed and at least one running container,
      open Claude.app, click the environment dropdown. Verify the avm
      container appears. Start a session against it. Verify the session
      lands in `~/work` on the container.
12. **Restore:** `cp ~/.claude/settings.json.bak ~/.claude/settings.json`
    if any test left it in an unexpected state.

### Files
- (no code changes; verification only)

### Done criteria
- All twelve verification steps pass with the documented behaviour.
- The desktop app shows avm containers in the environment dropdown and a
  session can be opened against one (step 11 — the only test that proves
  the integration actually works end-to-end).
- The `### Result` block records each step's outcome.
