# Migration: Claude-baked-in avm → agent-agnostic avm

One-time runbook for upgrading an existing avm install past the
agent-harness-decoupling change. Designed to be readable by a
host-side Claude agent that walks through the migration on behalf of
the user. **Not** needed for fresh installs (use the README
"First-Time Setup" section instead).

## What's automatic

On the next `avm` command after the upgrade, `migrateLegacyLayout`
runs once and:

- moves `~/.avm/system/credentials/ssh` → `~/.avm/volumes/ssh`
- moves `~/.avm/system/credentials/git` → `~/.avm/volumes/git`
- moves `~/.avm/system/claude`           → `~/.avm/volumes/claude`
- moves `~/.avm/system/claude.json`      → `~/.avm/volumes/claude.json`
- deletes `~/.avm/system/CLAUDE.md` (regenerated as `~/.avm/AGENTS.md`)
- removes the now-empty `~/.avm/system/` directory
- prints a one-time hint listing the `config.yaml` additions still
  needed

The hint looks like:

```
==> Legacy ~/.avm/system layout detected. Files moved to ~/.avm/volumes.
    Declare them in ~/.avm/config.yaml to restore previous behaviour:

      agents_md: ~/CLAUDE.md
      skills_dir: ~/.claude/skills
      volumes:
        - ssh:~/.ssh
        - git:~/.config/git
        - claude:~/.claude
        - claude.json:~/.claude.json
      integrations:
        claude_notifications: true   # if previously enabled
        claude_desktop: true         # if previously enabled
```

If a destination already exists, the move is skipped and avm prints a
collision notice naming both paths. The user (or the host agent) must
inspect the legacy path and either delete it or fold it into the new
location by hand.

## What needs manual config.yaml edits

`~/.avm/config.yaml` needs the following additions to restore the
previous Claude-baked-in behaviour. The host agent applies these with
its standard file-edit tool — a careful textual edit that inserts the
new top-level keys near related ones and preserves user comments and
ordering. Do not overwrite the file or blindly append to the end;
merge into existing structure where it makes sense (e.g. extend an
existing `volumes:` block rather than starting a new one).

```yaml
agents_md: ~/CLAUDE.md          # was implicit: ~/CLAUDE.md
skills_dir: ~/.claude/skills    # was implicit
volumes:
  - ssh:~/.ssh                  # was a fixed mount
  - git:~/.config/git           # was a fixed mount
  - claude:~/.claude            # was a fixed mount (Claude users)
  - claude.json:~/.claude.json  # was a fixed mount (Claude users)
integrations:
  claude_notifications: true    # if previously enabled (see below)
  claude_desktop: true          # if previously enabled (see below)
```

Skip the `claude:` and `claude.json:` volumes (and the
`claude_notifications` / `claude_desktop` toggles) if the user isn't
running Claude.

## Detecting prior integration state

Pre-upgrade `~/.avm/state.json` contained two now-removed fields that
recorded prior opt-in:

- `desktopConfig.installPrompt === "installed"` → user had Claude
  desktop sync enabled
- `notifications.installPrompt === "installed"` → user had Claude
  notify hooks installed

The upgrade strips both fields. No automatic backup is made, so the
information is gone unless the user has their own snapshot. **In
practice the host agent should just ask the user:** "Did you
previously have the Claude desktop dropdown showing avm containers?"
and "Did you previously have `avm notify install` run?" Both questions
are short and the answers are easy for the user to recall.

## Agent runbook

1. **Detect legacy state.** Trigger conditions (any):
   - The output of a recent `avm` command contains
     `Legacy ~/.avm/system layout detected` or `[migrate] …`.
   - `~/.avm/volumes/{ssh,git}` exist but `~/.avm/config.yaml` doesn't
     declare them under `volumes:`.

2. **Read `~/.avm/config.yaml`.** Compute which of the four blocks
   above (top-level `agents_md`, top-level `skills_dir`, the `volumes:`
   entries, the `integrations:` block) are missing.

3. **Confirm with the user**, one quick question at a time:
   1. "Are you running Claude Code as the agent? (most existing users
      are.)" If yes → keep the `claude:` / `claude.json:` volumes,
      `agents_md: ~/CLAUDE.md`, `skills_dir: ~/.claude/skills`. If no
      → use the README "Using a different agent harness" guide
      instead.
   2. "Want Claude notification hooks (sound + macOS banner on
      `Notification`/`Stop`)?" If yes →
      `integrations.claude_notifications: true`. After applying,
      remind the user to run `avm notify install`.
   3. "Want avm containers in Claude desktop's environment dropdown?"
      If yes → `integrations.claude_desktop: true`. After applying,
      run `avm ssh-config install --desktop` (or `avm ssh-config sync`
      if already installed) to seed the initial sync.

4. **Apply the additions to `~/.avm/config.yaml`.** Use a careful
   textual edit: insert each new top-level key near related ones
   (e.g. `agents_md` and `skills_dir` near other top-level keys, new
   `volumes:` entries appended to an existing `volumes:` block, the
   `integrations:` block near `daemon:` / `prune_images:`). Preserve
   comments and ordering; do not rewrite the whole file.

5. **For Claude users: ensure `~/.avm/volumes/claude.json` exists.**
   If missing, `touch ~/.avm/volumes/claude.json`. File-target volumes
   need the source to exist before `docker run` mounts succeed.

6. **Verify** by running `avm create <test-name> --attach`. Confirm:
   - The migration hint no longer prints (means avm found all the
     now-declared volumes).
   - Inside the container: `ls -la ~/CLAUDE.md` (mounted),
     `ls ~/.claude/skills` (avm-* skills symlinked),
     `git config --get user.email` returns the user's identity.
   - If the user kept the Claude block in their Dockerfile:
     `claude --version` works.

7. **Clean up:** `avm clean <test-name>`.

## When NOT to follow this guide

- **Fresh installs** (no `~/.avm/system/` directory existed). Follow
  the "First-Time Setup" section of the README instead.
- **Non-Claude harness users.** Skip the Claude-specific entries and
  adapt per the "Using a different agent harness" section in the
  README.
- **Users whose `config.yaml` already declares the four blocks above**
  (e.g. they applied the migration hint by hand). No further action
  needed.
