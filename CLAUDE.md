# alcova-vm

A CLI for managing OrbStack VMs that sandbox Claude Code agents. Read
`README.md` first for the big picture.

## Package Manager

This project uses **pnpm** (via corepack). Use `pnpm install`, `pnpm exec`,
`pnpm run`, etc. Never use npm or yarn.

## Scripting

All scripts are TypeScript with [google/zx](https://github.com/google/zx).
No bash or shell scripts anywhere in the repo. If you need to shell out,
use zx's `$` template literal.

When passing multi-line shell commands to SSH, pipe them via stdin rather
than argument-passing — `$({ input: cmd })\`ssh ... bash -l\`` — because
OpenSSH concatenates remote arguments with spaces before the remote shell
re-parses them, which breaks anything non-trivial.

## Project Principles

- **Thin wrapper over `orb`.** The CLI orchestrates OrbStack and SSH. It
  does not maintain its own state, database, or long-running service.
  `orb list -f json` is the source of truth for what VMs exist. Anything
  richer than that is explicitly out of scope.
- **VMs are reusable workspaces, not per-PR containers.** The user creates
  them manually, keeps them around for a thread of work, and cleans them
  up manually. Don't add auto-cleanup, TTLs, or "one VM per branch"
  features.
- **Defer decisions.** `avm start` doesn't require a repo or a branch.
  Those choices happen inside the VM, via Claude, once the user is there.
- **`~/.avm/` is host-side state, user-owned.** Mirrors, credentials,
  env files, caches, Claude Code state, user setup script, and
  `config.yaml` all live under the user's home directory. The repo
  never reads or writes anything under `~/.avm/` at install time —
  users populate it themselves (see README "First-Time Setup").
- **`templates/` seeds `~/.avm/system/claude/`.** Files under
  `templates/` are committed and canonical. `avm create`/`avm start`
  copy `vm-claude.md` into `~/.avm/system/claude/CLAUDE.md` only if the
  target doesn't already exist, so users can customize freely without
  losing their edits on upgrade.
- **`examples/` ships user-facing starting points.** `examples/setup.sh`
  is the reference user setup script users copy to `~/.avm/setup.sh`.
- **No automated tests.** This is a CLI glue layer; the valuable
  verification is running the commands end-to-end. Don't add unit or
  integration tests unless the user explicitly asks for them.
- **Manual end-to-end testing.** When you change behavior that affects
  `avm start`, test by actually starting a VM and checking what you
  changed.

## File Structure

```
bin/avm.mjs                     # global entrypoint wrapper (for pnpm link)
cli/avm.ts                      # citty entrypoint, registers subcommands
cli/commands/*.ts               # one file per subcommand
lib/config.ts                   # paths + constants (AVM_HOME + derived)
lib/config-file.ts              # parse ~/.avm/config.yaml, generate avm-link
lib/session.ts                  # shared session mount + lockdown orchestration
lib/vm.ts                       # SSH helpers, orb wrappers, ID utilities
lib/base-vm.ts                  # minimal core provisioner; runs ~/.avm/setup.sh
templates/vm-claude.md          # seed for ~/.avm/system/claude/CLAUDE.md
templates/vm-helpers.sh         # installed at /opt/avm/helpers.sh in every base VM
examples/setup.sh               # reference ~/.avm/setup.sh
skills/avm/SKILL.md             # host-side Claude Code skill (symlinked in by users)
docs/superpowers/               # design specs and implementation plans
```

Files in `lib/` are small and focused. Each command file in `cli/commands/`
is self-contained and reads from `lib/` for shared logic. Don't introduce
cross-command utilities — keep commands independent.

## When Modifying

- **Adding a new command:** add `cli/commands/<name>.ts`, wire it into
  `cli/avm.ts`. Follow the pattern of the existing commands — citty's
  `defineCommand`, positional args via `args._`, `@clack/prompts` for
  interactive input.
- **Changing mounts or VM setup:** edit `lib/session.ts`. Any new
  fixed mount should also be documented in the README's "Host Data
  Layout" section and the in-VM template at `templates/vm-claude.md`.
  User-configurable mounts belong in `~/.avm/config.yaml`, not in code.
- **Changing the base VM core:** edit `lib/base-vm.ts`, then rebuild
  with `avm provision`. Don't try to mutate a running base VM — the
  script is the source of truth. The base VM must be stopped before
  `avm provision` will rebuild it. For toolchain installs, edit
  `~/.avm/setup.sh` (your own, not `examples/setup.sh`) rather than
  `lib/base-vm.ts`.
- **Adding a per-repo config:** edit `~/.avm/config.yaml`. Drop the
  source files under `~/.avm/files/` (for symlinks) or
  `~/.avm/volumes/` (for bind mounts). Nothing in the repo changes.
