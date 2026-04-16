# alcova-vm

A CLI for managing Docker containers that sandbox Claude Code agents. Read
`README.md` first for the big picture.

## Terminology

These terms define the layers and actors in the system. Use them
consistently in code, docs, specs, and conversation.

- **avm** — the system as a whole: the CLI, the daemon, the container
  images, and the workflow they enable.
- **host** — the user's machine that runs the `avm` CLI and manages
  containers. macOS with OrbStack.
- **user** — the human operator. The same person whether they're
  typing in a host terminal or directing an in-container agent. There
  is only one user.
- **host agent** — an agent running on the host machine (e.g. the
  user's Claude Code session). Its job is helping the user configure
  and operate their avm setup. It does NOT work on the user's
  codebases directly — that's what avm containers are for.
- **avm agent / in-container agent** — an agent running inside an avm
  container, typically with `--dangerously-skip-permissions`. This is
  the agent that does actual codebase work.
- **avm CLI** — the host-side CLI (`avm create`, `avm start`, etc.).
  A control interface for the user and/or the host agent.
- **avm daemon** — a long-running process on the host that acts as
  the control plane. The avm CLI and avm-bridge both talk to it.
- **avm-bridge** — an in-container CLI for the avm agent to
  coordinate with the host control plane (daemon). It is NOT for the
  host to run. Think of it as "phone home from inside the sandbox."

When writing specs, docs, or code: be precise about which layer an
action happens on and which actor initiates it. "The agent opens a
file" is ambiguous — specify whether the host agent or the avm agent
is acting, and whether the action happens on the host or inside the
container.

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

- **Use avm commands for all container operations.** The daemon
  maintains state (registered containers, host secrets, etc.) that
  must stay in sync with Docker. Use `avm create`, `avm stop`,
  `avm clean`, `avm exec`, etc. Do not bypass avm and use docker
  directly unless avm itself is genuinely broken and you are
  debugging it.
- **Containers are flexible workspaces.** Users may keep them around
  semi-persistently for a thread of work, or spin them up ephemerally
  for a single task and clean them up immediately. Don't impose a
  specific container lifetime model. Don't add auto-cleanup, TTLs, or
  "one container per branch" features — the user decides the lifecycle.
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
pnpm-workspace.yaml             # workspace config
packages/avm/src/cli/avm.ts     # host CLI entrypoint
packages/avm/src/cli/commands/   # host CLI subcommands
packages/avm/src/lib/           # host CLI shared logic
packages/avm-daemon/src/        # daemon server
packages/avm-bridge/src/        # in-container CLI
packages/shared/src/            # proto types + Connect client factories
proto/avm/bridge/v1/            # bridge API protos
proto/avm/host/v1/              # host API protos
dockerfiles/core.Dockerfile     # core Docker image definition (avm-core:latest)
templates/vm-claude.md          # seed for ~/.avm/system/claude/CLAUDE.md
templates/vm-helpers.sh         # installed at /opt/avm/helpers.sh in every image
examples/Dockerfile             # reference ~/.avm/Dockerfile
examples/config.yaml            # reference ~/.avm/config.yaml
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
