---
name: avm-repos
description: Use when the agent needs to clone a repo, create a git worktree, set up a workspace, or apply repo env files, secrets, or config overrides ("link env vars", "set up the env", "secrets are missing"). Must be consulted before cloning a repo or creating a worktree.
---

# Setting up repos in avm

Use `avm-bridge clone <name>` to set up a repo in `~/work/`. The bridge
resolves the host mirror at `~/mirrors/<name>.git` (if present), runs
`git clone --reference`, and applies any per-repo symlinks declared in
the user's avm config — all in one step.

## Usage

```
avm-bridge clone <name>
```

This clones into `~/work/<name>`. If `~/mirrors/<name>.git` exists, the
clone is reference-based (fast). After cloning, per-repo symlinks (env
files, config overrides, etc.) are applied automatically.

If there is no mirror for `<name>`, ask the user for the clone URL and
pass it explicitly:

```
avm-bridge clone <name> --url <git-url>
```

To skip the post-clone link step:

```
avm-bridge clone <name> --no-link
```

## Applying env, secrets, and config to a working copy

Repo env files, secrets, and config overrides are delivered as symlinks
into the working copy, declared in the user's avm config. `avm-bridge
clone` applies them automatically. Every other working copy starts with
none — a git worktree, a manual clone, a second checkout. Apply them
from inside it:

```
cd <working-copy>
avm-bridge link
```

`link` uses the directory's basename as the repo name. Pass it
explicitly if they differ: `avm-bridge link <name>`. Safe to re-run,
including after the user edits their config; repos not declared in
config are a no-op.

When the user says "link env vars", "set up the env", or "the secrets
are missing", run `avm-bridge link` in the working copy. Do not go
hunting for a `.env` file or generate one.

### Worktrees

A new `git worktree` is a fresh directory with none of the repo's
symlinks. Run `avm-bridge link` from inside it before working:

```
git worktree add ../<name>-<branch> <branch>
cd ../<name>-<branch>
avm-bridge link <name>
```

## Manual clones (rare)

For non-default targets — a different directory, a specific branch,
submodules, or a second remote — clone with `git` directly, then run
`avm-bridge link <name>` from inside the working copy.

## Scope: clone and setup only

After cloning, you may install workspace dependencies (e.g.
`pnpm install`, `bundle install`) but **stop there**. Do not start
services, dev servers, run database migrations, or take any action
that affects runtime state or makes assumptions about external
systems — unless the user explicitly asks.

"Set up the repo" means clone it, link it, and install dependencies —
not run it.
