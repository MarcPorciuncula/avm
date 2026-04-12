---
name: avm-repos
description: Use when the agent needs to clone a repo, set up a workspace, or asks about mirrors or avm-link. Must be consulted before cloning any repo.
---

# Cloning repos in avm

Clone repos into `~/work/`.

## Using mirrors

If a mirror exists at `~/mirrors/<name>.git`, use it for faster clones:

```
git clone --reference ~/mirrors/<name>.git \
  git@github.com:<owner>/<name>.git \
  ~/work/<name>
```

If there's no mirror, clone normally. **Never** pass `--dissociate`
and **never** run `git gc` on mirrors.

## After cloning: `avm-link`

Run `avm-link` from inside the working copy to set up per-repo
symlinks (env files, config overrides, etc.):

```
cd ~/work/<name>
avm-link
```

Safe to re-run. Repos not in the config are a no-op.
