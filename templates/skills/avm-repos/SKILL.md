---
name: avm-repos
description: Use when the agent needs to clone a repo or set up a workspace. Must be consulted before cloning any repo.
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

## Re-applying links in an existing working copy

If you already have a working copy and want to re-apply per-repo
symlinks (e.g. after the user edited their config), run from inside it:

```
cd ~/work/<name>
avm-bridge link
```

By default `link` uses the directory's basename as the repo name. Pass
the name explicitly if they differ: `avm-bridge link <name>`. Safe to
re-run; repos not declared in config are a no-op.

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
