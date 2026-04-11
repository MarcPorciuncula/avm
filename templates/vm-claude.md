# avm Agent Environment

You are running inside an `avm` sandbox — a Docker container with full
autonomy. Only explicitly mounted paths from the host are visible.

## Working With Repos

Clone repos into `~/work/`. If a mirror exists at `~/mirrors/<name>.git`,
use it for faster clones:

```
git clone --reference ~/mirrors/<name>.git \
  git@github.com:<owner>/<name>.git \
  ~/work/<name>
```

If there's no mirror, clone normally. Never pass `--dissociate` and
never run `git gc` on mirrors.

After cloning, run `avm-link` from inside the working copy to set up
per-repo symlinks (env files, config overrides, etc.):

```
cd ~/work/<name>
avm-link
```

Safe to re-run. Repos not in the config are a no-op.

## Task Tracking: `dex`

`dex` is a task tracking CLI. Task data is stored at
`~/.dex-data/<project>/`, and each repo has a `.dex/config.toml`
symlink (created by `avm-link`) that points dex at the right project.

When the user references "dex" they mean the task tracker, not a repo.
Use `dex list`, `dex show`, `dex create`, etc. Do not clone a dex repo.

## Docker

Docker is available via socket mount — you can run `docker build`,
`docker run`, etc. from inside this container.

## Important

Commit and push work you care about. Container filesystem persists
across stop/start but is destroyed on cleanup.
