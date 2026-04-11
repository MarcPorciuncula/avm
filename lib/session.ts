import { $, path } from "zx";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
} from "node:fs";
import {
  AVM_HOME,
  avmFilesDir,
  avmMirrorsDir,
  avmSystemClaudeDir,
  avmSystemClaudeJsonFile,
  avmSystemDir,
  avmSystemGitConfigFile,
  avmSystemSshDir,
  avmVolumesDir,
  REPO_ROOT,
} from "./config.ts";
import {
  type AvmConfig,
  generateAvmLinkScript,
  type VolumeMount,
} from "./config-file.ts";
import { asRoot } from "./vm.ts";

// TODO(docker-port): session mounts will be replaced with docker volume
// mounts. For now, keep the host path reference for bind-mount commands
// that run inside containers with the host filesystem mounted.
const vmHostAvmHome = `/mnt/mac${AVM_HOME}`;

// Path where `~/.avm/files/` is bind-mounted inside the VM. Chosen so it
// lives under the agent's home and is not touched by the lockdown of
// /mnt/mac and /Users.
const VM_FILES_DIR = "/home/agent/.avm-files";

/**
 * Ensure host-side `~/.avm/system/*` scaffolding exists for session VMs
 * that need to mount it. Creates directories and an empty claude.json if
 * missing so bind-mounts don't fail. Does NOT populate anything — users
 * provide their own credentials and claude state.
 */
export function ensureHostScaffolding(): void {
  const requiredDirs = [
    avmSystemDir,
    avmSystemSshDir,
    path.dirname(avmSystemGitConfigFile),
    avmSystemClaudeDir,
    avmMirrorsDir,
    avmVolumesDir,
    avmFilesDir,
  ];
  for (const dir of requiredDirs) {
    mkdirSync(dir, { recursive: true });
  }

  // The bind mount for ~/.claude.json is a file mount, so the file has to
  // exist on both sides. Create an empty one if missing.
  if (!existsSync(avmSystemClaudeJsonFile)) {
    closeSync(openSync(avmSystemClaudeJsonFile, "a"));
  }
}

/**
 * Seed `~/.avm/system/claude/CLAUDE.md` from `templates/vm-claude.md` if
 * the destination doesn't exist yet. Once seeded, the user owns the file;
 * the CLI never overwrites it.
 */
export function seedInVmClaudeMd(): void {
  const dest = path.join(avmSystemClaudeDir, "CLAUDE.md");
  if (existsSync(dest)) return;
  const template = path.join(REPO_ROOT, "templates", "vm-claude.md");
  if (existsSync(template)) {
    copyFileSync(template, dest);
  }
}

/**
 * Apply all session mounts to a running VM: fixed system mounts, the
 * `~/.avm/files` holding mount, user volume mounts from config.yaml, the
 * generated `avm-link` script, and the gitconfig copy. Idempotent — safe
 * to call on both fresh clones and on resumed VMs (where orb stop blew
 * the old mounts away).
 */
export async function applySessionMounts(
  vmName: string,
  config: AvmConfig,
): Promise<void> {
  ensureHostScaffolding();
  seedInVmClaudeMd();

  // --- Fixed system mounts ---

  console.log("==> Setting up bind-mounts...");
  await asRoot(
    vmName,
    `
    set -euo pipefail
    mkdir -p /home/agent/.ssh /home/agent/.claude /home/agent/mirrors ${VM_FILES_DIR}
    touch /home/agent/.claude.json

    mount --bind "${vmHostAvmHome}/system/credentials/ssh" /home/agent/.ssh
    mount --bind "${vmHostAvmHome}/system/claude" /home/agent/.claude
    mount --bind "${vmHostAvmHome}/system/claude.json" /home/agent/.claude.json
    mount --bind "${vmHostAvmHome}/mirrors" /home/agent/mirrors
    mount --bind "${vmHostAvmHome}/files" ${VM_FILES_DIR}

    chown agent:agent /home/agent/.claude.json
    chown -R agent:agent /home/agent/.ssh /home/agent/.claude /home/agent/mirrors ${VM_FILES_DIR}
  `,
  );

  // --- Copy gitconfig (not a mount — it's a small identity file) ---

  console.log("==> Copying git config...");
  await asRoot(
    vmName,
    `
    set -euo pipefail
    if [ -f "${vmHostAvmHome}/system/credentials/git/.gitconfig" ]; then
      cp "${vmHostAvmHome}/system/credentials/git/.gitconfig" /home/agent/.gitconfig
      chown agent:agent /home/agent/.gitconfig
    else
      echo "    (no ~/.avm/system/credentials/git/.gitconfig — skipping)" >&2
    fi
  `,
  );

  // --- User volume mounts ---

  if (config.volumes.length > 0) {
    console.log("==> Applying user volume mounts...");
    for (const volume of config.volumes) {
      await applyVolumeMount(vmName, volume);
    }
  }

  // --- Generated avm-link ---

  console.log("==> Installing /usr/local/bin/avm-link...");
  const script = generateAvmLinkScript(config);
  await $({
    input: script,
  })`docker exec -i -u root ${vmName} bash -c "cat > /usr/local/bin/avm-link && chmod +x /usr/local/bin/avm-link"`;
}

/**
 * Bind-mount empty directories over /mnt/mac and /Users so the agent user
 * can't traverse back to the host filesystem. VirtioFS doesn't support
 * chmod, so this mask is the only reliable way to lock these down.
 */
export async function applyLockdown(vmName: string): Promise<void> {
  console.log("==> Locking down host mount...");
  await asRoot(
    vmName,
    `
    set -euo pipefail
    mkdir -p /tmp/empty-mnt /tmp/empty-users
    mount --bind /tmp/empty-mnt /mnt/mac
    mount --bind /tmp/empty-users /Users
  `,
  );
}

// ---------- Private helpers ----------

/** Apply a single user volume mount, resolving source and target paths. */
async function applyVolumeMount(
  vmName: string,
  volume: VolumeMount,
): Promise<void> {
  const hostSource = resolveVolumeSource(volume.source);
  const vmSource = volume.source.startsWith("/")
    ? volume.source
    : `${vmHostAvmHome}/volumes/${volume.source}`;
  const vmTarget = resolveVolumeTarget(volume.target);

  if (!existsSync(hostSource)) {
    console.warn(
      `    [warn] volume source missing: ${hostSource} — skipping mount to ${vmTarget}`,
    );
    return;
  }

  await asRoot(
    vmName,
    `
    set -euo pipefail
    mkdir -p "${vmTarget}"
    mount --bind "${vmSource}" "${vmTarget}"
    chown -R agent:agent "${vmTarget}" || true
  `,
  );
}

/** Resolve a host-side volume source (for existence checks). */
function resolveVolumeSource(source: string): string {
  if (source.startsWith("/")) return source;
  return path.join(avmVolumesDir, source);
}

/**
 * Resolve a volume target to an absolute path inside the VM.
 * - Absolute paths pass through.
 * - `~/` expands to `/home/agent/`.
 * - Relative paths are rooted at `/home/agent/`.
 */
function resolveVolumeTarget(target: string): string {
  if (target.startsWith("/")) return target;
  if (target.startsWith("~/")) return `/home/agent/${target.slice(2)}`;
  return `/home/agent/${target}`;
}
