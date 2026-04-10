# alcova-vm Agent Environment

You are running inside an alcova-vm sandbox — an OrbStack Linux VM cloned
from `alcova-base`. The host macOS filesystem is locked down and not
accessible from this VM. You have full autonomy within the sandbox and are
expected to run with `--dangerously-skip-permissions` (use the `clauded`
alias).

## Toolchain

- Node 24 (via nodesource)
- pnpm (via corepack — use `pnpm`, never `npm` or `yarn`)
- Python 3
- Go (latest stable, at `/usr/local/go/bin`). `GOPRIVATE=github.com/Alcova-AI/*`
  is preconfigured so `go mod` fetches Alcova private modules directly via
  git (which uses the mounted SSH keys).
- Atlas CLI — database schema migrations (`atlas` on PATH)
- Task — `taskfile.dev` task runner (`task` on PATH)
- Buf CLI — protobuf lint/generate (`buf` on PATH)
- golangci-lint, staticcheck — Go linters
- Docker + Docker Compose — for running `alcova-backend`'s PostgreSQL +
  Temporal stack. The `agent` user is in the `docker` group.
- Standard build tools: `build-essential`, `git`, `curl`, `jq`

A system-wide git URL rewrite maps `https://github.com/Alcova-AI/` →
`git@github.com:Alcova-AI/` so private Go modules fetch via SSH.

## Filesystem Layout

- `~/work/` — where project repos live. Clone new repos here.
- `~/mirrors/` — bare mirrors of known repos, bind-mounted read-mostly from
  the host. Use these to accelerate `git clone` (see below).
- `~/envs/` — project `.env` files, bind-mounted from the host. Files are
  named `<repo>.env` (flat, e.g. `operator-ui.env`). Symlink them into your
  cloned repos as needed (see below).
- `~/.ssh/` — SSH keys and config, bind-mounted from the host. These are your
  GitHub credentials — treat them accordingly.
- `~/.claude/` — your Claude Code home directory, bind-mounted from the host.
  Shared across all alcova-vm sessions.
- `~/.claude.json` — Claude Code settings file, bind-mounted from the host.
- `~/.gitconfig` — copied from the host at VM creation.
- `~/.local/share/pnpm/store/` — shared pnpm content-addressed store,
  bind-mounted from the host.

## Cloning Repos

Local bare mirrors of known repos are at `~/mirrors/<repo>.git`. Always
clone through the mirror to save time and disk space:

```
git clone --reference ~/mirrors/<repo>.git \
  git@github.com:Alcova-AI/<repo>.git \
  ~/work/<repo>
```

Do **not** pass `--dissociate`. The clone keeps a link to the mirror's
object database, which is the intended behavior — it saves hundreds of MB
per clone and speeds up future fetches. The mirror is fetch-only from the
host; never run `git gc` on it from within the VM.

If you need to work on a repo that isn't mirrored, clone from GitHub
directly. SSH keys are available.

## Env Files

Project `.env` files live at `~/envs/<repo>.env` and are mounted from the
host. After cloning a repo, symlink its env file into the working copy:

```
ln -sf ~/envs/<repo>.env ~/work/<repo>/.env
```

If `avm start --clone` was used, the symlink is already in place for every
known repo that has a matching env file.

Never commit `.env` files — they're symlinks to host-mounted secrets. If
you need to edit a project's env, edit the file at `~/envs/<repo>.env`
(the change persists to the host).

## Known Repos

- `operator-ui` — Vite/React frontend. Node 24 + pnpm. Depends on
  `alcova-backend` for protobuf definitions. Dev server runs on port 3000
  via `pnpm dev`. OrbStack auto-forwards the port to the host.
- `alcova-backend` — Go backend. Uses Task for orchestration, Atlas for
  DB migrations, Docker Compose for PostgreSQL + Temporal. Common
  commands:
  - `docker-compose up postgres temporal` — start infrastructure
  - `task server` — run API server
  - `task worker` — run worker service
  - `atlas migrate ...` — DB schema ops (see repo README)
  - Note: running DB migrations requires the `migration_admin` PostgreSQL
    user to be set up first via `psql -f setup-users.sql`.

If `avm start --clone` was used, these repos are already at `~/work/<repo>`
with `.env` files in place. Otherwise, clone them yourself as needed.

## Workflow

- Use `git` normally. Commits will use whatever identity is in the mounted
  `~/.gitconfig`.
- Push branches to `origin` freely — SSH auth works.
- Run `pnpm install` in a repo before running its dev/build commands.
- The shared pnpm store means subsequent `pnpm install`s across VMs are
  fast.

## Persistence

These survive across VM sessions (they're host-mounted):
- `~/.ssh/`, `~/.claude/`, `~/.claude.json`, `~/.gitconfig`, `~/mirrors/`,
  `~/envs/`, the pnpm store

Everything else in the VM is ephemeral. When the VM is deleted
(`avm clean <id>` on the host), anything under `~/work/` or `/tmp` is gone.
Commit and push work you care about.
