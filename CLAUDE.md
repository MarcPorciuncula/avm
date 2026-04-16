# alcova-vm

A CLI for managing Docker containers that sandbox Claude Code agents. Read
`README.md` first for the big picture.

## Package Manager

This project uses **pnpm** (via corepack). Use `pnpm install`, `pnpm exec`,
`pnpm run`, etc. Never use npm or yarn.

## Scripting

All scripts are TypeScript with [google/zx](https://github.com/google/zx).
No bash or shell scripts anywhere in the repo. If you need to shell out,
use zx's `$` template literal.

When passing multi-line shell commands to `docker exec`, pipe them via
stdin rather than argument-passing —
`$({ input: cmd })\`docker exec -i ... bash -l\`` — because shell
argument concatenation breaks anything non-trivial.

## Project Principles

- **Thin wrapper over `docker`.** The CLI orchestrates Docker containers.
  It does not maintain its own state, database, or long-running service.
  `docker ps --filter label=avm=true` is the source of truth for what
  containers exist. Anything richer than that is explicitly out of scope.
- **Containers are reusable workspaces, not per-PR containers.** The user
  creates them manually, keeps them around for a thread of work, and
  cleans them up manually. Don't add auto-cleanup, TTLs, or "one
  container per branch" features.
- **Defer decisions.** `avm start` doesn't require a repo or a branch.
  Those choices happen inside the container, via Claude, once the user
  is there.
- **`~/.avm/` is host-side state, user-owned.** Mirrors, credentials,
  env files, caches, Claude Code state, user Dockerfile, and
  `config.yaml` all live under the user's home directory. The repo
  never reads or writes anything under `~/.avm/` at install time —
  users populate it themselves (see README "First-Time Setup").
- **`templates/` seeds `~/.avm/system/claude/`.** Files under
  `templates/` are committed and canonical. `avm create`/`avm start`
  copy `vm-claude.md` into `~/.avm/system/claude/CLAUDE.md` only if the
  target doesn't already exist, so users can customize freely without
  losing their edits on upgrade.
- **`templates/vm-claude.md` is scoped to in-container needs only.**
  This file is the only guidance the inner agent sees about `avm`.
  Keep it minimal — describe only what the agent needs to operate
  *inside* the sandbox. Do not mention host-side management
  (`avm` subcommands, paths under `~/.avm/`, `config.yaml`, image
  provisioning, the `avm` repo itself) or anything the inner agent
  cannot act on from within the container. If it's not actionable from
  inside the sandbox, it does not belong here.
- **`examples/` ships user-facing starting points.** `examples/Dockerfile`
  is the reference user Dockerfile users copy to `~/.avm/Dockerfile`.
- **No automated tests.** This is a CLI glue layer; the valuable
  verification is running the commands end-to-end. Don't add unit or
  integration tests unless the user explicitly asks for them.
- **Manual end-to-end testing.** When you change behavior that affects
  `avm start`, test by actually starting a container and checking what
  you changed.

## File Structure

```
bin/avm.mjs                     # global entrypoint wrapper (for pnpm link)
cli/avm.ts                      # citty entrypoint, registers subcommands
cli/commands/*.ts               # one file per subcommand
lib/config.ts                   # paths + constants (AVM_HOME + derived)
lib/config-file.ts              # parse ~/.avm/config.yaml, generate avm-link
lib/session.ts                  # shared session mount + post-creation orchestration
lib/vm.ts                       # Docker exec helpers, container wrappers, ID utilities
lib/image.ts                    # Docker image builder; builds core + user images
dockerfiles/core.Dockerfile     # core Docker image definition (avm-core:latest)
templates/vm-claude.md          # seed for ~/.avm/system/claude/CLAUDE.md
templates/vm-helpers.sh         # installed at /opt/avm/helpers.sh in every image
examples/Dockerfile             # reference ~/.avm/Dockerfile
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
- **Changing mounts or container setup:** edit `lib/session.ts`
  (`getDockerMountArgs` for fixed mounts, `applyPostCreationSetup` for
  post-creation steps). Any new fixed mount should also be documented in
  the README's "Host Data Layout" section and the in-container template
  at `templates/vm-claude.md`. User-configurable mounts belong in
  `~/.avm/config.yaml`, not in code.
- **Changing the core Docker image:** edit `dockerfiles/core.Dockerfile`,
  then rebuild with `avm provision`. For toolchain installs, edit
  `~/.avm/Dockerfile` (your own, not `examples/Dockerfile`) rather than
  the core Dockerfile.
- **Adding a per-repo config:** edit `~/.avm/config.yaml`. Drop the
  source files under `~/.avm/files/` (for symlinks) or
  `~/.avm/volumes/` (for bind mounts). Nothing in the repo changes.
