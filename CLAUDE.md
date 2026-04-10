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
- **`data/` is host-side state, gitignored.** Mirrors, credentials, env
  files, cache, Claude Code state — all live here. Never commit anything
  under `data/`.
- **`templates/` seeds `data/`.** Files under `templates/` are committed
  and canonical. `avm start` copies them into `data/` only if the target
  doesn't already exist, so users can customize freely without losing
  their edits on upgrade.
- **No automated tests.** This is a CLI glue layer; the valuable
  verification is running the commands end-to-end. Don't add unit or
  integration tests unless the user explicitly asks for them.
- **Manual end-to-end testing.** When you change behavior that affects
  `avm start`, test by actually starting a VM and checking what you
  changed.

## File Structure

```
bin/avm.mjs                 # global entrypoint wrapper (for pnpm link)
cli/avm.ts                  # citty entrypoint, registers subcommands
cli/commands/*.ts           # one file per subcommand
lib/config.ts               # constants, paths, REPO_DEPS
lib/vm.ts                   # SSH helpers, orb wrappers, ID utilities
lib/mirrors.ts              # bare mirror management
setup/base-vm-provision.ts  # source of truth for the base VM image
templates/vm-claude.md      # seed for data/claude/CLAUDE.md
skills/avm/SKILL.md         # host-side Claude Code skill (symlinked in by users)
data/                       # host-side state, gitignored
docs/superpowers/           # design specs and implementation plans
```

Files in `lib/` are small and focused. Each command file in `cli/commands/`
is self-contained and reads from `lib/` for shared logic. Don't introduce
cross-command utilities — keep commands independent.

## When Modifying

- **Adding a new command:** add `cli/commands/<name>.ts`, wire it into
  `cli/avm.ts`. Follow the pattern of the existing commands — citty's
  `defineCommand`, positional args via `args._`, `@clack/prompts` for
  interactive input.
- **Changing mounts or VM setup:** edit `cli/commands/start.ts`. Any new
  mount should also be documented in the README's "Host Data Layout"
  section and the in-VM template at `templates/vm-claude.md`.
- **Changing the base VM image:** edit `setup/base-vm-provision.ts`, then
  rebuild with `pnpm run provision -- --reprovision`. Don't try to mutate
  a running base VM — the script is the source of truth.
- **Adding a repo to `REPO_DEPS`:** edit `lib/config.ts`. Any new primary
  repo gets its `.env` file at `data/envs/<repo>.env` on the host.
