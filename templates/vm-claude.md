# avm Agent Environment

You are running inside an `avm` sandbox — an OrbStack Linux VM cloned
from the `avm-base` template. The host macOS filesystem is locked down
and not accessible from this VM. You have full autonomy within the
sandbox and are expected to run with `--dangerously-skip-permissions`
(use the `clauded` alias).

## Filesystem Layout

- `~/work/` — where project repos live. Clone new repos here.
- `~/mirrors/` — bare git mirrors, bind-mounted from the host. If a repo
  has a mirror at `~/mirrors/<name>.git`, reference-clone through it to
  save bandwidth and disk. If there's no mirror, clone directly from the
  remote.
- `~/.avm-files/` — read-only overlay files from the host. These are the
  sources behind the symlinks `avm-link` creates (env files, config
  overrides, etc.). You usually don't touch these directly — `avm-link`
  does.
- `~/.ssh/` — SSH keys and config, bind-mounted from the host. These are
  your GitHub credentials.
- `~/.claude/` and `~/.claude.json` — Claude Code home and settings,
  bind-mounted from the host. Shared across every avm session.
- `~/.gitconfig` — copied from the host at VM creation/resume.

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
inside the VM.

## Per-Repo Config: `avm-link`

After cloning a repo, run `avm-link` from inside the working copy:

```
cd ~/work/<name>
avm-link
```

`avm-link` reads the per-repo config the user declared in
`~/.avm/config.yaml` on the host and creates symlinks for env files,
config overrides, etc. It's generated per-VM at session startup, so
changes to `config.yaml` take effect on the next `avm create` or
`avm start`. Safe to re-run — uses `ln -sf`.

If the current directory name doesn't match a repo key in the config,
pass the name explicitly:

```
avm-link <name>
```

Repos that aren't in the config are a no-op — `avm-link` exits 0 without
doing anything.

## Claude Code

The `clauded` alias runs Claude Code with
`--dangerously-skip-permissions`. Use it freely — this is the whole
point of the sandbox.

## Persistence

Host-bind-mounted state survives VM stop/start/delete:

- `~/.ssh/`, `~/.claude/`, `~/.claude.json`, `~/.gitconfig`
- `~/mirrors/`, `~/.avm-files/`
- Whatever volumes the user declared in `~/.avm/config.yaml` (caches,
  package stores, build output, etc.)

Everything else in the VM is ephemeral. When the VM is deleted
(`avm clean <id>` on the host), anything under `~/work/` or `/tmp` is
gone. Commit and push work you care about.

Working copies under `~/work/` DO persist across `avm stop` + `avm start`
— stop just stops the VM; the filesystem isn't wiped. Only `avm clean`
deletes them.

## Host-Side Commands (for context, not for running here)

These are the host commands the user runs to manage VMs. You can't run
them from inside the VM; `avm` is host-side only.

- `avm create [name]` — create a new VM and start it
- `avm start <id>` — resume a stopped VM
- `avm stop <id>` — stop (without deleting) a running VM
- `avm attach <id>` — SSH back into a running VM
- `avm clean <id>` — stop and delete a VM (destroys `~/work/`)
- `avm list` — list all session VMs
