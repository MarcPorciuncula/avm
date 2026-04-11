# avm Agent Environment

You are running inside an `avm` sandbox — a Docker container managed by
the `avm` CLI on the host. The host macOS filesystem is not accessible
from this container — only explicitly mounted paths are visible. You
have full autonomy within the sandbox and are expected to run with
`--dangerously-skip-permissions` (use the `clauded` alias).

## Filesystem Layout

- `~/work/` — where project repos live. Clone new repos here.
- `~/mirrors/` — bare git mirrors, mounted from the host. If a repo
  has a mirror at `~/mirrors/<name>.git`, reference-clone through it to
  save bandwidth and disk. If there's no mirror, clone directly from the
  remote.
- `~/.avm-files/` — read-only overlay files from the host. These are the
  sources behind the symlinks `avm-link` creates (env files, config
  overrides, etc.). You usually don't touch these directly — `avm-link`
  does.
- `~/.ssh/` — SSH keys and config, mounted from the host. These are
  your GitHub credentials.
- `~/.claude/` and `~/.claude.json` — Claude Code home and settings,
  mounted from the host. Shared across every avm session.
- `~/.gitconfig` — copied from the host at container creation/resume.

## Docker

Docker is available via socket mount — you can run `docker build`,
`docker run`, and other Docker commands from inside this container
(Docker-out-of-Docker).

## Cloning Repos

If a mirror exists, use it:

```
git clone --reference ~/mirrors/<name>.git \
  git@github.com:<owner>/<name>.git \
  ~/work/<name>
```

If there's no mirror (no `~/mirrors/<name>.git`), just clone normally:

```
git clone git@github.com:<owner>/<name>.git ~/work/<name>
```

Never pass `--dissociate`. Reference-clones keep a link to the mirror's
object database — that's the point. Never run `git gc` on mirrors from
inside the container.

## Per-Repo Config: `avm-link`

After cloning a repo, run `avm-link` from inside the working copy:

```
cd ~/work/<name>
avm-link
```

`avm-link` reads the per-repo config the user declared in
`~/.avm/config.yaml` on the host and creates symlinks for env files,
config overrides, etc. It's generated per-container at session startup,
so changes to `config.yaml` take effect on the next `avm create` or
`avm start`. Safe to re-run — uses `ln -sf`.

If the current directory name doesn't match a repo key in the config,
pass the name explicitly:

```
avm-link <name>
```

Repos that aren't in the config are a no-op — `avm-link` exits 0 without
doing anything.

## Task Tracking: `dex`

`dex` is a task tracking CLI installed in this container. Task data is
stored at `~/.dex-data/<project>/` (mounted from the host), and each
repo has a `.dex/config.toml` symlink (created by `avm-link`) that
points dex at the right project store.

When the user references "dex" they mean the task tracker, not a repo.
Use `dex list`, `dex show`, `dex create`, etc. to interact with tasks.
Do not clone or work in a dex source repo.

## Persistence

Mounted state survives `docker stop` / `docker start` (`avm stop` /
`avm start`):

- `~/.ssh/`, `~/.claude/`, `~/.claude.json`, `~/.gitconfig`
- `~/mirrors/`, `~/.avm-files/`
- Whatever volumes the user declared in `~/.avm/config.yaml` (caches,
  package stores, build output, etc.)

Container state (everything in the container filesystem including
`~/work/`) also persists across `avm stop` + `avm start` — stop just
stops the container; the filesystem isn't wiped.

Only `avm clean` removes the container. When the container is removed
(`avm clean <id>` on the host), anything under `~/work/` or `/tmp` is
gone. Commit and push work you care about.

## Host-Side Commands (for context, not for running here)

These are the host commands the user runs to manage containers. You
can't run them from inside the container; `avm` is host-side only.

- `avm create [name]` — create a new container and start it
- `avm start <id>` — resume a stopped container
- `avm stop <id>` — stop (without deleting) a running container
- `avm attach <id>` — attach to a running container
- `avm clean <id>` — stop and delete a container (destroys `~/work/`)
- `avm list` — list all session containers
