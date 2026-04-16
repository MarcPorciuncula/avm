---
name: avm-repos
description: Use when the agent needs to clone a repo, set up a workspace, or asks about mirrors or avm-link. Must be consulted before cloning any repo.
---

# Cloning repos in avm

Clone repos into `~/work/`.

## Using mirrors

If a mirror exists at `~/mirrors/<name>.git`, use it for faster clones.
**Get the remote URL from the mirror** — do not guess it:

```
git -C ~/mirrors/<name>.git remote get-url origin
```

Then clone with `--reference`:

```
git clone --reference ~/mirrors/<name>.git <url> ~/work/<name>
```

If there's no mirror, ask the user for the clone URL. **Never** pass
`--dissociate` and **never** run `git gc` on mirrors.

## After cloning: `avm-link`

Run `avm-link` from inside the working copy to set up per-repo
symlinks (env files, config overrides, etc.):

```
cd ~/work/<name>
avm-link
```

By default `avm-link` uses the directory name to look up the repo
config. If the directory name doesn't match the repo name in the
config (e.g. you cloned into a differently-named folder), pass the
repo name explicitly:

```
avm-link <repo-name>
```

Safe to re-run. Repos not in the config are a no-op.

## Scope: clone and setup only

After cloning and running `avm-link`, you may install workspace
dependencies (e.g. `pnpm install`, `bundle install`) but **stop
there**. Do not start services, dev servers, run database migrations,
or take any action that affects runtime state or makes assumptions
about external systems — unless the user explicitly asks.

"Set up the repo" means clone it, link it, and install dependencies —
not run it.
