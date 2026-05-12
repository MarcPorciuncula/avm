# Decouple avm from a specific agent harness

**Status:** design pending final-question resolution
**Date:** 2026-05-12

## Problem

avm currently bakes Claude Code into multiple layers of the system:

- The core image installs Claude (`dockerfiles/core.Dockerfile:53`) and adds
  a `clauded` alias (`:66`).
- `getDockerMountArgs` (`packages/avm/src/lib/session.ts:161-170`) hard-codes
  Claude-specific mounts: `~/.claude`, `~/.claude.json`, `~/CLAUDE.md`.
- The auto-generated guidance file is named after Claude (`CLAUDE.md`).
- `applyPostCreationSetup` symlinks avm skills into `~/.claude/skills`
  unconditionally.
- The bridge ships a `claude-hook` adapter that knows Claude's hook event
  vocabulary.
- First-run prompts in `avm create` and `avm provision` push Claude desktop
  registration and Claude notification hooks regardless of which harness the
  user runs.

None of this is hostile to non-Claude harnesses, but it is not factored
cleanly either. A user who wants to run Codex, Aider, OpenCode, or a custom
CLI has to either (a) accept Claude installed alongside their actual harness,
or (b) build a different core image from scratch. There is no composable
middle path.

With the repo now public, the cost of these defaults is visible to non-Claude
users evaluating avm. The fix is to pull Claude-specific behaviour out of
avm itself and re-deliver it as a composition pattern: the user's
`~/.avm/Dockerfile` installs whichever harness they want; `~/.avm/config.yaml`
declares the mounts, integrations, and target paths the harness expects;
`examples/` ships a Claude-defaults bundle that reproduces today's behaviour
verbatim when copied as-is.

## Goals

1. **Generic core image.** `dockerfiles/core.Dockerfile` installs only the
   system layer (Ubuntu, agent user, Docker/SSH, avm-bridge, helpers). No
   Claude, no `clauded` alias, no Claude-specific paths.
2. **Mounts are composable.** Only avm machinery (bridge binary, generated
   guidance file, mirrors/files paths used by bridge commands) is hard-coded
   in `getDockerMountArgs`. Credentials and harness state become regular
   `config.yaml` volumes.
3. **Configurable agent guidance file.** Auto-generated guidance is written
   to `~/.avm/AGENTS.md` (the cross-harness convention) and mounted into
   containers. A new `agents_md` config field controls the in-container mount
   target(s), supporting string or list-of-strings so Claude users can
   redirect to `~/CLAUDE.md`.
4. **Configurable skills directory.** Where avm's `avm-*` skills get
   symlinked is config-driven via `skills_dir` (string or list). Default
   unset → skip the symlink step.
5. **Integrations are config, not state.** A new `integrations:` block holds
   `claude_notifications` and `claude_desktop` booleans. The corresponding
   first-run prompts are removed; the install/uninstall commands flip the
   config flag and run the existing sync logic.
6. **Atomic, end-to-end renames where they aid clarity.** `~/.avm/system/`
   flattens (its contents move to `~/.avm/{volumes,AGENTS.md}`).
   `templates/vm-claude.md` → `templates/agents.md`. `avm-bridge
   claude-hook` is intentionally **not** renamed — it is a Claude-specific
   adapter (reads Claude's hook JSON over stdin, maps Claude's event
   vocabulary to internal notification kinds), and the harness name in the
   command honestly reflects that scope.
7. **Transparent migration.** A first-run migration on detected legacy layout
   moves `~/.avm/system/credentials/{ssh,git}` → `~/.avm/volumes/{ssh,git}`
   and `~/.avm/system/claude{,.json}` → `~/.avm/volumes/claude{,.json}`, then
   prints a one-time hint with the `config.yaml` snippet needed to restore
   today's behaviour.
8. **`examples/` ships today's defaults via composition.** Copying
   `examples/Dockerfile` + `examples/config.yaml` produces a working
   Claude-flavored avm setup identical in observable behaviour to current
   avm.

## Non-goals (v1)

- **An `agents:` config schema.** Considered and rejected — three things
  (guidance file target, skills directory, integration toggles) are
  genuinely agent-specific. Everything else is achievable with the existing
  `volumes:` primitive plus user Dockerfile edits.
- **Auto-detection of which harness the user runs.** No probing of
  `~/.claude/`, `~/.codex/`, package presence in the image, etc.
- **A generic `avm-bridge notify <kind>` command** alongside
  `claude-hook`. A non-Claude harness whose hook system can't shape its
  payload to look like Claude's would need this, but YAGNI until a
  second supported harness shows up.
- **Migrating the user's `config.yaml`.** Migration moves files on disk but
  does not edit `config.yaml` — the hint shows what to add. Auto-editing
  user-authored config is too invasive.
- **Per-harness preset bundles in the repo.** `examples/` ships Claude
  defaults only. Codex/Aider/etc. users adapt the example or contribute their
  own preset later.
- **A `presets/` directory or `include:` directive.** Same reasoning as
  above; YAGNI until we have a second supported harness.
- **Customizing the AGENTS.md generator template.** The template file is
  fixed at `templates/agents.md`. Users layering their own guidance use their
  harness's own mechanism (e.g., `~/.claude/CLAUDE.md` via a volume).
- **Runtime fallback if a Claude-specific volume source is missing.** The
  existing `[warn] volume source missing` line stays; users see the warning
  and create the source path.
- **An `avm migrate` command.** The auto-migration runs from
  `ensureHostScaffolding` on every relevant command; an explicit migration
  command is unnecessary.

## Architecture

### Layout before/after

```
                       before                                           after
                       ──────                                           ─────

~/.avm/                                              ~/.avm/
├── config.yaml                                      ├── config.yaml
├── Dockerfile                                       ├── Dockerfile
├── build-context/                                   ├── build-context/
├── ssh_config                                       ├── ssh_config
├── state.json                                       ├── state.json
├── daemon/                                          ├── daemon/
├── system/                                          ├── AGENTS.md          ← was system/CLAUDE.md
│   ├── credentials/                                 ├── mirrors/           ← unchanged
│   │   ├── ssh/      ← FIXED mount                 ├── files/             ← unchanged
│   │   └── git/      ← FIXED mount                 └── volumes/
│   ├── claude/       ← FIXED mount                     ├── ssh/           ← was system/credentials/ssh
│   ├── claude.json   ← FIXED mount                     ├── git/           ← was system/credentials/git
│   └── CLAUDE.md     ← FIXED mount                     ├── claude/        ← was system/claude (Claude users)
├── mirrors/                                             ├── claude.json    ← was system/claude.json (Claude users)
├── files/                                               └── pnpm-store/    ← user-declared, unchanged
└── volumes/
    └── pnpm-store/   ← user-declared volume
```

### Mount discipline

```
                                                Fixed (avm machinery):
Fixed mounts today (in code):                   - bridgeBin → /usr/local/bin/avm-bridge
- ssh dir → ~/.ssh                              - avmMirrorsDir → ~/mirrors
- git dir → ~/.config/git                       - avmFilesDir → ~/.avm-files
- claude dir → ~/.claude                        - avmAgentsMdFile → mount target(s) from agents_md
- claude.json → ~/.claude.json
- CLAUDE.md → ~/CLAUDE.md                       User-declared in config.yaml volumes:
- mirrors → ~/mirrors                           - ssh:~/.ssh                       (anyone using SSH)
- .avm-files → ~/.avm-files                     - git:~/.config/git                (anyone using git)
- bridge bin → /usr/local/bin/avm-bridge        - claude:~/.claude                 (Claude users)
                                                - claude.json:~/.claude.json       (Claude users)
                                                - <any cache>:<target>             (per-toolchain)

                                                Path conventions (bridge contract, in-container):
                                                - ~/mirrors      (read by `avm-bridge clone`)
                                                - ~/.avm-files   (read by `avm-bridge link`)
                                                - /usr/local/bin/avm-bridge
```

### Config-driven agent-specific behaviour

```
~/.avm/config.yaml                              consumer
─────────────────                              ────────
agents_md: ~/CLAUDE.md                         getDockerMountArgs → -v ~/.avm/AGENTS.md:~/CLAUDE.md

skills_dir:                                    applyPostCreationSetup → for each path:
  - ~/.claude/skills                              ln -s /opt/avm/skills/* <path>
  - ~/.codex/skills

integrations:                                  syncHostIntegrations:
  claude_notifications: true     ─────────▶      if claude_notifications: install hooks into ~/.claude/settings.json
  claude_desktop: true           ─────────▶      if claude_desktop:        sync sshConfigs into ~/.claude/settings.json
```

## Components

### `~/.avm/` layout constants (`packages/avm/src/lib/config.ts`)

Remove:
- `avmSystemDir`
- `avmSystemSshDir`
- `avmSystemGitDir`
- `avmSystemClaudeDir`
- `avmSystemClaudeJsonFile`
- `avmSystemClaudeMdFile`

Add:
- `avmAgentsMdFile = path.join(AVM_HOME, "AGENTS.md")`

Unchanged:
- `avmMirrorsDir`, `avmVolumesDir`, `avmFilesDir`, `avmConfigFile`,
  `avmStateFile`, `avmSshConfigFile`, daemon constants.

### Configuration schema (`packages/avm/src/lib/config-file.ts`)

Three new top-level keys:

```ts
export interface AvmConfig {
  // ... existing fields ...
  agents_md: string[];          // default ["~/AGENTS.md"]
  skills_dir: string[];         // default [] (no symlink)
  integrations: IntegrationsConfig;
}

export interface IntegrationsConfig {
  claude_notifications: boolean;  // default false
  claude_desktop: boolean;        // default false
}
```

Parser behaviour:
- `agents_md`: accept string or array of strings; normalize to `string[]`.
  Each entry runs through the unsafe-character check used by `splitShortForm`
  (rejects `" $ \` \` and control chars).
- `skills_dir`: accept string or array of strings; normalize to `string[]`.
  Empty array → skip the symlink step.
- `integrations`: mapping with two booleans. Unknown sub-keys produce the
  standard warning. Both default `false`.

Add a small helper for the install/uninstall commands to flip integration
flags while preserving user formatting:

```ts
export function setConfigIntegration(
  key: "claude_notifications" | "claude_desktop",
  value: boolean,
): void;
```

Uses `parseDocument` so comments and ordering survive.

### Mount construction (`packages/avm/src/lib/session.ts`)

`getDockerMountArgs` reduces to:

1. Three fixed avm-machinery mounts (bridge bin, mirrors, files).
2. One mount per entry in `config.agents_md` (source: `avmAgentsMdFile`).
3. Existing per-user `config.volumes` loop, unchanged.

`ensureHostScaffolding` reduces to:
- Create `~/.avm/`, `~/.avm/{mirrors,files,volumes,build-context}/`.
- Call `migrateLegacyLayout()` (see below).
- Generate `~/.avm/AGENTS.md` via the renamed `generateAgentsMd`.
- No longer seeds `claude.json` or any harness state.

`applyPostCreationSetup`:
- The skill symlink loop iterates over `config.skills_dir`. Empty list →
  skip entirely. For each path, `mkdir -p <path>` in the container and
  symlink `/opt/avm/skills/*/` into it.
- AVM_* env-var persistence and `avm-bridge` chmod remain unchanged.

`generateRootClaudeMd` renames to `generateAgentsMd`; the host services
section logic is unchanged.

### Migration (`packages/avm/src/lib/session.ts`)

`migrateLegacyLayout()` runs at the top of `ensureHostScaffolding`,
idempotent and short-circuits when `~/.avm/system/` is absent. Behaviour:

- For each `(src, dst)` in `[ssh, git, claude, claude.json]`: if `src`
  exists and `dst` doesn't, `mkdir -p dirname(dst)` and `renameSync(src, dst)`.
  Log one line per move.
- If `~/.avm/system/CLAUDE.md` exists, delete it (regenerated as
  `~/.avm/AGENTS.md` later in the same scaffolding pass).
- `rmdir` `~/.avm/system/credentials` and `~/.avm/system` if empty.
- If any move ran, call `printMigrationHint(movedVolumes)` to show the
  `config.yaml` snippet needed to declare the moved volumes.

The hint prints the full snippet (agents_md, skills_dir, volumes,
integrations) every time at least one volume is missing from
`config.yaml`, so the user has a clear pointer until they apply it. See
Open Question 1 for the alternative.

### Core image (`dockerfiles/core.Dockerfile`)

Remove:
- The Claude install block (line 53).
- The `clauded` alias line (line 66).
- `COPY templates/vm-claude.md /home/agent/CLAUDE.md` and the chown (lines
  88-89). The file is bind-mounted from the host on every container start;
  the COPY only existed as a static fallback.

Keep:
- System packages, Node.js, Docker engine (DinD), agent user setup,
  helpers.sh, start-dockerd.sh, start-sshd.sh, xdg-open shim.
- `COPY templates/skills/ /opt/avm/skills/` — these are avm-* skills, not
  Claude skills. Still needed by `applyPostCreationSetup`.

Rename: `templates/vm-claude.md` → `templates/agents.md`. Update body to
refer to the guidance file generically (the actual in-container path
depends on `agents_md` — Claude users see `~/CLAUDE.md`, others see
`~/AGENTS.md`). Reference both names in the "don't edit this file"
sentence.

### Examples (`examples/Dockerfile`, `examples/config.yaml`)

`examples/Dockerfile` appends a clearly-labelled Claude Code block:

```dockerfile
# --- Claude Code -----------------------------------------------------------
# Installs Claude into ~/.claude. The host bind-mounts
# ~/.avm/volumes/claude into ~/.claude (see examples/config.yaml volumes:)
# so login state persists across containers. Remove this section if you use
# a different agent harness.

USER agent
RUN curl -fsSL https://claude.ai/install.sh | bash && \
    echo 'alias clauded="claude --dangerously-skip-permissions"' >> ~/.bashrc
USER root
```

`examples/config.yaml` becomes the full Claude-defaults reference:

```yaml
# ~/.avm/config.yaml — Claude Code defaults.
# Copying this file as-is reproduces avm's previous baked-in behaviour:
# Claude state and credentials mounted into every container, AGENTS.md
# presented as CLAUDE.md, Claude desktop integration enabled.

agents_md: ~/CLAUDE.md
skills_dir: ~/.claude/skills

volumes:
  # Credentials
  - ssh:~/.ssh
  - git:~/.config/git
  # Claude Code state (persists across containers; shared between them)
  - claude:~/.claude
  - claude.json:~/.claude.json
  # Caches (optional but recommended)
  - pnpm-store:~/.local/share/pnpm/store

editor: cursor

integrations:
  # Forward Claude's Notification/Stop hooks to host notifications.
  # Run `avm notify install` after enabling.
  claude_notifications: true
  # Register avm containers as SSH environments in Claude desktop.
  # Run `avm ssh-config install` after enabling.
  claude_desktop: true

daemon:
  port: 6970

prune_images:
  enabled: true
  keep_recent: 1
```

### Notify hooks (`packages/avm/src/lib/notify-hooks.ts`,
`packages/avm-bridge/src/cli/commands/claude-hook.ts`)

Unchanged. The bridge adapter, the hook command strings written to
`~/.claude/settings.json`, and the entry-detection prefix
(`AVM_HOOK_COMMAND_PREFIX = "avm-bridge claude-hook "`) all stay. Only
the *install/uninstall plumbing* moves (next section): the flag that
gates the install lives in `config.yaml` instead of `state.json`.

### State cleanup (`packages/avm/src/lib/state.ts`)

Remove `desktopConfig` from `AvmState`. Remove any notify-install state
fields. The SSH-config Include's `sshConfig.installPrompt` remains —
that's generic to anyone wanting `ssh avm-<id>` to work.

### Desktop config (`packages/avm/src/lib/desktop-config.ts`)

`installDesktopConfig` shifts from state-write to config-write:

```ts
export async function installDesktopConfig(): Promise<void> {
  setConfigIntegration("claude_desktop", true);
  await syncDesktopConfig();
}

export async function uninstallDesktopConfig(): Promise<void> {
  // Drop avm-owned entries regardless of flag state (uninstall is total).
  // ...existing entry-stripping body...
  setConfigIntegration("claude_desktop", false);
}
```

`syncHostIntegrations` reads the flag from config:

```ts
export async function syncHostIntegrations(): Promise<void> {
  await syncSshConfig();
  const config = loadAvmConfig();
  if (config.integrations.claude_desktop) {
    await syncDesktopConfig();
  }
}
```

### First-run prompt removal

- `packages/avm/src/cli/commands/create.ts:146-166` — delete the desktop
  registration prompt block.
- `packages/avm/src/cli/commands/provision.ts:54` — delete the
  `maybePromptForInstall()` call.
- The SSH-config Include prompt at `create.ts:118-143` stays.

The `--desktop` / `--no-desktop` flags on `avm ssh-config install` are
retained but become flag-setters: they edit `config.yaml` via
`setConfigIntegration` and run the corresponding sync. Same model for
`avm notify install` / `--no-notify`.

### Notify daemon master switch

`notifications.enabled` (current top-level config field consumed by the
daemon at runtime) is **kept** as a runtime kill-switch, conceptually
distinct from `integrations.claude_notifications` (which controls whether
hook entries are installed in Claude's settings.json). A user can have
hooks installed but the daemon silenced for a day. See Open Question 4.

The `notifications.sounds` block likewise stays — host-side audio
configuration is independent of harness.

### README and skill updates

`README.md`:
- Rewrite "First-Time Setup" around the Claude-defaults composition flow
  (steps in §Data flow below).
- Add a "Using a different agent harness" subsection that names the four
  knobs to change.
- Update the "Host Data Layout" diagram to the new flat layout.
- Update the `templates/vm-claude.md` references to `templates/agents.md`.
- Note the configurable `agents_md`, `skills_dir`, and `integrations`
  fields in "Customizing".

`skills/avm/SKILL.md`:
- Update "First-time setup on a fresh machine" section to match the new
  flow.
- Update CLAUDE.md mentions to AGENTS.md, noting the configurability.
- Update the in-container layout snippet (`~/CLAUDE.md` → `~/AGENTS.md`
  by default).

`templates/agents.md`:
- Body refers to the file generically; the "don't edit this file"
  sentence names both possible mount paths.

`templates/skills/avm-*/SKILL.md`:
- Scan for any CLAUDE.md references and update to AGENTS.md.

## Data flow

### Scenario 1: Fresh install, Claude defaults

1. `mkdir -p ~/.avm/volumes/{ssh,git,claude}; touch ~/.avm/volumes/claude.json`
2. `cp ~/.ssh/id_ed25519{,.pub} ~/.ssh/config ~/.avm/volumes/ssh/`
3. `cp ~/.gitconfig ~/.avm/volumes/git/config`
4. `cp <avm-repo>/examples/Dockerfile  ~/.avm/Dockerfile`
5. `cp <avm-repo>/examples/config.yaml ~/.avm/config.yaml`
6. `avm provision` — builds `avm-core:latest` (no Claude) and
   `avm:latest` (with Claude, per user Dockerfile).
7. `avm create --attach`:
   - `ensureHostScaffolding` creates dirs, runs migration (no-op),
     generates `~/.avm/AGENTS.md`.
   - `getDockerMountArgs`:
     - fixed: bridge bin, mirrors, files
     - agents_md: `~/.avm/AGENTS.md → /home/agent/CLAUDE.md`
     - volumes: ssh, git, claude, claude.json, pnpm-store
   - `applyPostCreationSetup` symlinks `/opt/avm/skills/*/` into
     `~/.claude/skills` per `skills_dir`.
8. Inside the container: `clauded` runs Claude with
   `--dangerously-skip-permissions`. Skills are discoverable. CLAUDE.md
   is at the expected path.

### Scenario 2: Fresh install, different harness (e.g. Codex)

1. `mkdir -p ~/.avm/volumes/{ssh,git,codex}` + copy credentials.
2. User edits `~/.avm/Dockerfile`: removes the Claude block, adds a Codex
   install (`npm i -g @openai/codex` or whatever).
3. `~/.avm/config.yaml`:
   ```yaml
   skills_dir: ~/.codex/skills
   volumes:
     - ssh:~/.ssh
     - git:~/.config/git
     - codex:~/.codex
   ```
   `agents_md` unset → defaults to `~/AGENTS.md`. `integrations` unset →
   both `false`.
4. `avm provision; avm create --attach`.
5. Inside the container: Codex CLI works; skills are at
   `~/.codex/skills/avm-*/`; guidance is at `~/AGENTS.md`. No Claude
   leftovers anywhere.

### Scenario 3: Existing user upgrades

1. User pulls the new avm. Their `~/.avm/system/credentials/{ssh,git}`,
   `~/.avm/system/claude/`, and `~/.avm/system/claude.json` still exist.
2. Next `avm` command (any command that calls `ensureHostScaffolding` —
   `provision`, `create`, etc.).
3. `migrateLegacyLayout` moves all four to `~/.avm/volumes/{ssh,git,claude,claude.json}`.
   Old `system/` directory is cleaned up.
4. The migration hint prints with the full config.yaml snippet. Their
   existing `config.yaml` doesn't declare those volumes yet, so on this
   first run the migrated content isn't mounted.
5. **The command continues running** — it doesn't fail. (For non-`create`
   commands like `provision`, this is fine; for `create`, the resulting
   container comes up without credentials. The hint is the user's signal
   to update config before they `avm clean` and recreate.)
6. User reads the hint, pastes it into `config.yaml`, runs
   `avm clean <id> && avm create` for a properly-mounted container.

### Scenario 4: Existing user upgrades and had desktop/notification integrations enabled

A subset of Scenario 3. Old `state.json` had `desktopConfig.installPrompt
=== "installed"` or notify-install equivalents.

- Migration drops `state.desktopConfig`. New defaults are `false` for both
  integration flags, so the user is implicitly opted out of sync until
  they update `config.yaml`.
- The migration hint includes both `integrations.claude_*: true` lines so
  the user re-opts in by pasting.
- See Open Question 3 for whether to migrate state into config
  automatically instead.

## Edge cases

| Case | Behaviour |
|---|---|
| `~/.avm/system/` doesn't exist (fresh install) | `migrateLegacyLayout` is a no-op. Hint not printed. |
| Legacy `~/.avm/system/credentials/ssh` and new `~/.avm/volumes/ssh` both exist | Migration logs `[migrate] ~/.avm/volumes/ssh exists — skipped`. Move is not forced. User resolves by hand. |
| User sets `skills_dir: ~/.claude/skills` before installing Claude | The symlink step `mkdir -p ~/.claude/skills` creates the dir; symlinks land there. Claude finds them when installed later. No harm. |
| User sets `agents_md: []` | Validator accepts empty list — file is generated but not mounted into any path. Quiet opt-out for harnesses that don't want a top-level guidance file. |
| User sets `agents_md` to a path with unsafe chars | Same unsafe-character check applied; throws with a clear error. |
| User edits `~/.avm/AGENTS.md` directly | Overwritten on next `ensureHostScaffolding` call (same as today's CLAUDE.md behaviour). User-level guidance belongs in their harness's own file via a volume. |
| User has `integrations.claude_desktop: true` but `~/.claude/settings.json` is malformed JSON | Sync throws with the file path and remediation hint (existing `readSettings` behaviour). Other commands continue. |
| Multiple `agents_md` targets, same file content mounted twice | Two `-v` flags from the same source to different targets. Docker handles this without complaint. |
| User declares `agents_md: [~/AGENTS.md, ~/CLAUDE.md]` (e.g. running both Claude and Codex) | Both mount targets get the same generated content. Works as intended. |
| User has `~/.avm/system/CLAUDE.md` with custom edits | The migration deletes it; content is lost. Mitigation: today's CLAUDE.md is auto-generated, so any user edits would already have been lost on the next `ensureHostScaffolding`. No real regression. |
| User config has `editor: nvim` (after example added that flexibility — *not in this spec*) | Out of scope; the editor enum stays as `code\|cursor\|zed` per current schema. |
| Concurrent `avm` processes both run `migrateLegacyLayout` | `renameSync` is atomic; the second process sees the destination already exists and skips. No corruption. |

## Out-of-scope (deferred)

- **Auto-editing user `config.yaml` on migration.** Discussed; rejected for v1.
- **Per-harness preset bundles** in a `presets/` directory.
- **Customizable AGENTS.md template path** (e.g.
  `~/.avm/AGENTS.md.tmpl` overriding `templates/agents.md`).
- **Auto-create empty source files for file-target volumes** (e.g.
  `touch ~/.avm/volumes/claude.json` so the user doesn't have to). See
  Open Question 2.
- **An `avm migrate` command.**
- **Editor enum opening up** (`nvim`, `helix`, IntelliJ).
- **Notify daemon platform abstraction** (Linux/Windows). Notifications
  remain macOS-only via `afplay`/`osascript`. The integration toggles
  work on any host; only the *delivery* is darwin-only — and the gate
  in `main.ts` already logs a one-time warning on non-darwin.

## Testing strategy

No automated tests, per project convention (`CLAUDE.md` § "No automated
tests"). Verification is manual end-to-end across the three primary
scenarios (fresh install Claude defaults, fresh install with a different
harness mocked, existing-user migration) plus the edge-case table above
that is straightforward to exercise (malformed settings.json, missing
volume source, `agents_md: []`, etc.).

Specifics laid out in the implementation plan's final verification task.

## Resolved decisions

Captured here for posterity; each is folded into the spec body above.

- **Migration hint prints until resolved.** `printMigrationHint` compares
  the migrated set against `config.volumes` on every relevant command and
  prints only when at least one migrated entry isn't yet declared. Quiet
  once the user pastes the snippet.
- **No auto-creation of file-target volume sources.** Users `touch` the
  source file themselves (`~/.avm/volumes/claude.json` in the Claude
  walkthrough). Existing `[warn] volume source missing → skip` path is
  the safety net.
- **State-based integration flags are not auto-migrated into
  `config.yaml`.** Existing opted-in users see `integrations.claude_*`
  default to `false` after upgrade and re-opt-in via the migration hint.
- **`notifications.enabled` (runtime kill-switch) stays distinct from
  `integrations.claude_notifications` (install switch).** Two questions,
  two flags.
- **`--desktop`/`--no-desktop` and `--notify`/`--no-notify` flags on the
  install commands are retained** as convenience flag-setters that edit
  `config.yaml` via `setConfigIntegration`.
- **`avm-bridge claude-hook` is not renamed.** It is the Claude-specific
  hook adapter and its name reflects that. A future generic
  `avm-bridge notify <kind>` is deferred as a non-goal.
- **`agents_md` default is `["~/AGENTS.md"]`.** Unset → mount to that
  single path. Empty list (`[]`) → don't mount (clean opt-out).
- **No defence against the AGENTS.md host file being deleted mid-run.**
  Scaffolding regenerates it; if the user races a `rm`, the next
  command recovers.

## Plan decomposition note

The plan combines the `~/.avm/system/` layout rename and the AGENTS.md
rename into a single task: both touch the same constants in
`packages/avm/src/lib/config.ts` and `lib/session.ts`, and landing them
separately would leave a half-renamed intermediate state in either the
host layout or the in-container mount target. The plan otherwise breaks
along the major component boundaries documented above.
