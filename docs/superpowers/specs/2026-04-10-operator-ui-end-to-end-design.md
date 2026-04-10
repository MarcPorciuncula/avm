# End-to-End Setup: operator-ui Agent Sessions

First target repo for alcova-vm. Proves the full flow: base VM provisioning, per-session clone, credential injection, cache sharing, host mount lockdown, and a working dev environment with port access from the host.

## Target Repo

- **Repo:** `github.com/Alcova-AI/operator-ui`
- **Stack:** Node.js 24, pnpm, Vite, React 19, TanStack Start
- **Protobuf dependency:** `github.com/Alcova-AI/alcova-backend` (sibling directory for `buf generate`)
- **Auth:** Clerk (needs `VITE_CLERK_PUBLISHABLE_KEY` in `.env`)
- **Dev server:** `pnpm dev` on port 3000

## Deliverables

Two TypeScript/zx scripts and a `data/` directory layout. No CLI wrapper yet — manual invocation.

### 1. `setup/base-vm-provision.ts`

Creates and provisions the `alcova-base` Ubuntu VM. Source of truth for what's installed.

**Toolchain:**
- Node.js 24 (via nodesource)
- pnpm via corepack
- buf CLI (from GitHub releases, arm64)
- Python 3 + pip + venv
- Claude Code (official installer)
- System packages: build-essential, curl, wget, git, jq, unzip, zip, tar, openssh-client, ca-certificates, gnupg, software-properties-common, pkg-config, libssl-dev

**Configuration:**
- Default user: `agent`
- Git: `init.defaultBranch=main`, `pull.rebase=true`
- SSH: `StrictHostKeyChecking accept-new` for github.com
- Standard directories: `~/work`, `~/.ssh` (700)

**Usage:**
```bash
# Create base VM
pnpm exec tsx setup/base-vm-provision.ts

# Rebuild from scratch
pnpm exec tsx setup/base-vm-provision.ts --reprovision
```

**Flags:**
- `--reprovision` — stops and deletes existing `alcova-base`, then recreates from scratch

**Post-provision state:** VM is stopped, ready to clone.

### 2. `setup/session-setup.ts`

Takes a repo name and branch, produces a running VM with a working dev environment.

**Usage:**
```bash
pnpm exec tsx setup/session-setup.ts operator-ui feat/my-thing
```

**Steps (in order):**

#### 2a. Ensure mirrors exist and are fresh

For each of `operator-ui` and `alcova-backend`:
- If `data/mirrors/<repo>.git` doesn't exist, create it: `git clone --bare git@github.com:Alcova-AI/<repo>.git data/mirrors/<repo>.git`
- If it exists, update it: `git -C data/mirrors/<repo>.git fetch --all --prune`

#### 2b. Clone and start VM

- Derive VM name from repo + branch: `agent-operator-ui-<sanitized-branch>` (replace `/` with `-`, truncate if needed)
- `orb clone alcova-base <vm-name>`
- `orb start <vm-name>`
- Wait for SSH to be available

#### 2c. Bind-mount shared resources (as root)

All paths are relative to the alcova-vm repo root on the host. Inside the VM, they're accessible at `/mnt/mac<absolute-host-path>` before lockdown.

| Host path | VM path | Type |
|-----------|---------|------|
| `data/credentials/ssh/` | `/home/agent/.ssh/` | bind-mount |
| `data/credentials/claude/` | `/home/agent/.claude/` | bind-mount |
| `data/cache/shared/pnpm-store/` | `/home/agent/.local/share/pnpm/store/` | bind-mount |

Bind-mount steps (as root):
```bash
# Ensure target dirs exist
mkdir -p /home/agent/.ssh /home/agent/.claude /home/agent/.local/share/pnpm/store

# Bind-mount from host
mount --bind /mnt/mac<host-abs>/data/credentials/ssh /home/agent/.ssh
mount --bind /mnt/mac<host-abs>/data/credentials/claude /home/agent/.claude
mount --bind /mnt/mac<host-abs>/data/cache/shared/pnpm-store /home/agent/.local/share/pnpm/store

# Fix ownership on mount points
chown -R agent:agent /home/agent/.ssh /home/agent/.claude /home/agent/.local
```

#### 2d. Copy git config (as root)

```bash
cp /mnt/mac<host-abs>/data/credentials/git/.gitconfig /home/agent/.gitconfig
chown agent:agent /home/agent/.gitconfig
```

#### 2e. Reference-clone repos (as agent)

SSH keys are available via the bind-mount from step 2c.

```bash
git clone --dissociate \
  --reference /mnt/mac<host-abs>/data/mirrors/operator-ui.git \
  git@github.com:Alcova-AI/operator-ui.git \
  /home/agent/work/operator-ui

git clone --dissociate \
  --reference /mnt/mac<host-abs>/data/mirrors/alcova-backend.git \
  git@github.com:Alcova-AI/alcova-backend.git \
  /home/agent/work/alcova-backend
```

Then checkout the requested branch on operator-ui:
```bash
cd /home/agent/work/operator-ui
git checkout <branch>  # or git checkout -b <branch> if new
```

#### 2f. Copy `.env` (as root)

After the clone from step 2e exists:
```bash
cp /mnt/mac<host-abs>/data/credentials/operator-ui/.env /home/agent/work/operator-ui/.env
chown agent:agent /home/agent/work/operator-ui/.env
```

#### 2g. Lock down host mount (as root)

```bash
chmod 700 /mnt/mac
chmod 700 /Users
```

After this, the agent user cannot access the host filesystem. Bind-mounts remain functional.

#### 2h. Print connection info

```
Session ready.

  SSH:        ssh agent-operator-ui-my-thing@orb
  Dev server: http://localhost:3000 (after running pnpm dev)

  To start working:
    ssh agent-operator-ui-my-thing@orb
    cd ~/work/operator-ui
    pnpm install
    pnpm dev
```

### 3. `data/` Directory Layout

```
data/                                  # gitignored
  mirrors/
    operator-ui.git/                   # bare repo mirror
    alcova-backend.git/                # bare repo mirror
  credentials/
    ssh/                               # bind-mounted as ~/.ssh/
      id_ed25519                       # git SSH key
      config                           # SSH host config
    git/
      .gitconfig                       # agent git identity
    claude/                            # bind-mounted as ~/.claude/
      .credentials.json                # OAuth token (created on first interactive login)
    operator-ui/
      .env                             # project env vars (Clerk key, API URL, etc.)
  cache/
    shared/
      pnpm-store/                      # pnpm content-addressable store (safe to share)
```

## VM Internal Layout

After session setup completes:

```
/home/agent/
  work/
    operator-ui/            main repo, branch checked out, .env in place
    alcova-backend/         sibling for proto generation
  .ssh/                     bind-mount -> host data/credentials/ssh/
  .claude/                  bind-mount -> host data/credentials/claude/
  .gitconfig                copied from host
  .local/share/pnpm/store/  bind-mount -> host data/cache/shared/pnpm-store/

/mnt/mac                    chmod 700 (agent user locked out)
/Users                      chmod 700 (agent user locked out)
```

## First-Time Bootstrap

Before the first session, you need to populate `data/credentials/`:

1. **SSH key:** Copy or generate a key into `data/credentials/ssh/id_ed25519`. Add the public key to GitHub as a deploy key or to your account.
2. **SSH config:** Create `data/credentials/ssh/config` with the GitHub host entry.
3. **Git config:** Create `data/credentials/git/.gitconfig` with agent name and email.
4. **`.env`:** Copy `.env.example` from operator-ui, fill in real values, save to `data/credentials/operator-ui/.env`.
5. **Claude auth:** This happens interactively on the first session:
   - Run `session-setup.ts` (it mounts the empty `data/credentials/claude/` dir)
   - SSH in, run `claude`, complete OAuth login
   - Credentials persist to host via the bind-mount
   - All future sessions are authenticated automatically

## Cleanup

Manual for now:

```bash
orb stop agent-operator-ui-my-thing
orb delete -f agent-operator-ui-my-thing
```

## Port Access

OrbStack automatically forwards ports from VMs to the host. When the agent runs `pnpm dev` (port 3000), it's accessible at `http://localhost:3000` on the host with no configuration.

## Scope Boundaries

**In scope:**
- Base VM provisioning script
- Session setup script
- `data/` directory structure and gitignore
- Documentation of manual flow

**Out of scope (future work):**
- `alcova` CLI wrapper
- Session teardown script
- Go/Rust/other toolchains in base VM
- Multiple project support (beyond operator-ui + alcova-backend)
- Agent-to-host daemon communication
- Automated mirror updates (cron)
