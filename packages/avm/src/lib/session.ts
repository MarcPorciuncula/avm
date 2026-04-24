import { $, path } from "zx";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHostContainerClient } from "@avm/shared/host-client";
import {
  AVM_HOME,
  REPO_ROOT,
  avmFilesDir,
  avmMirrorsDir,
  avmSystemClaudeDir,
  avmSystemClaudeJsonFile,
  avmSystemClaudeMdFile,
  avmSystemDir,
  avmSystemGitDir,
  avmSystemSshDir,
  avmVolumesDir,
} from "./config.ts";
import { type AvmConfig, loadAvmConfig } from "./config-file.ts";
import { ensureDaemonRunning } from "./daemon.ts";

const distDir = dirname(fileURLToPath(import.meta.url));
const bridgeBin = join(distDir, "avm-bridge.mjs");

/**
 * Register a container with the daemon and return its token.
 */
export async function registerContainer(name: string): Promise<string> {
  const { port, secret } = await ensureDaemonRunning();
  const client = createHostContainerClient(port, secret);
  const response = await client.registerContainer({ name });
  return response.token;
}

/**
 * Unregister a container from the daemon. Errors are silently ignored
 * (the daemon may not be running during cleanup).
 */
export async function unregisterContainer(name: string): Promise<void> {
  try {
    const { port, secret } = await ensureDaemonRunning();
    const client = createHostContainerClient(port, secret);
    await client.unregisterContainer({ name });
  } catch {
    // Daemon might not be running during cleanup — that's OK.
  }
}

/**
 * Ensure host-side `~/.avm/system/*` scaffolding exists so docker volume
 * mounts don't fail on missing source dirs. Creates directories and an
 * empty claude.json if missing. Does NOT populate anything — users provide
 * their own credentials and claude state.
 */
export function ensureHostScaffolding(): void {
  const requiredDirs = [
    avmSystemDir,
    avmSystemSshDir,
    avmSystemGitDir,
    avmSystemClaudeDir,
    avmMirrorsDir,
    avmVolumesDir,
    avmFilesDir,
    path.join(AVM_HOME, "build-context"),
  ];
  for (const dir of requiredDirs) {
    mkdirSync(dir, { recursive: true });
  }

  // File mounts require the source to exist before `docker run`.
  // Seed with sensible defaults so mounts don't fail on first use.
  if (!existsSync(avmSystemClaudeJsonFile)) {
    writeFileSync(avmSystemClaudeJsonFile, "{}\n");
  }
  // Generate the root-level CLAUDE.md (always overwritten — avm owns this file).
  const config = loadAvmConfig();
  generateRootClaudeMd(config);
}

/**
 * Post-creation setup run after `docker run` or `docker start`.
 * Persists AVM_* env vars for SSH, symlinks image-shipped skills into
 * ~/.claude/skills/, and ensures avm-bridge is executable.
 */
export async function applyPostCreationSetup(
  containerName: string,
): Promise<void> {
  // --- Persist AVM_* env vars for SSH sessions ---
  // Docker container env vars (set via `docker run -e`) are only inherited by
  // `docker exec` sessions. SSH sessions start fresh shells that don't see
  // them. Append them to /etc/environment (read by pam_env for all session
  // types) so every SSH session — interactive, non-interactive, login or
  // not — picks them up.
  await $`docker exec -u root ${containerName} bash -c ${
    // Remove any existing AVM_ lines first (idempotent on restart), then append current values.
    'sed -i "/^AVM_/d" /etc/environment && ' +
    'env | grep "^AVM_" >> /etc/environment'
  }`;

  // --- Symlink image-shipped skills into ~/.claude/skills/ ---
  await $`docker exec ${containerName} bash -c ${
    "mkdir -p /home/agent/.claude/skills && " +
    "for d in /opt/avm/skills/*/; do " +
    'ln -sfn "$d" /home/agent/.claude/skills/$(basename "$d"); ' +
    "done"
  }`;

  // --- Make avm-bridge executable ---
  await $`docker exec -u root ${containerName} chmod +x /usr/local/bin/avm-bridge`;
}

/**
 * Generate the root-level `~/CLAUDE.md` that every container sees.
 * Written to `~/.avm/system/CLAUDE.md` on the host and bind-mounted
 * into containers — updates propagate to running containers immediately.
 *
 * Static content comes from `templates/vm-claude.md`. This function
 * appends dynamic sections (e.g. host services listing).
 */
export function generateRootClaudeMd(config: AvmConfig): void {
  const template = readFileSync(
    join(REPO_ROOT, "templates", "vm-claude.md"),
    "utf-8",
  );

  const parts = [template.trimEnd()];

  const serviceEntries = Object.entries(config.services);
  if (serviceEntries.length > 0) {
    parts.push("");
    parts.push("## Host services");
    parts.push("");
    parts.push("The following services are available on the host via `avm-bridge`.");
    parts.push("Consult the avm-services skill for usage.");
    parts.push("");
    for (const [name, svc] of serviceEntries) {
      parts.push(`- **${name}** — \`${svc.check.tcp}\``);
    }
  }

  parts.push("");

  writeFileSync(avmSystemClaudeMdFile, parts.join("\n"));
}

/**
 * Build the `-v` flag array for `docker run`. Encodes all fixed system
 * mounts and user-configured volumes from config.yaml.
 *
 * Returns a flat array like `["-v", "src:dst", "-v", "src:dst", ...]`.
 */
export function getDockerMountArgs(config: AvmConfig): string[] {
  const args: string[] = [];

  // --- Fixed system mounts ---
  const fixedMounts: [string, string][] = [
    [avmSystemSshDir, "/home/agent/.ssh"],
    [avmSystemClaudeDir, "/home/agent/.claude"],
    [avmSystemClaudeJsonFile, "/home/agent/.claude.json"],
    [avmSystemClaudeMdFile, "/home/agent/CLAUDE.md"],
    [avmSystemGitDir, "/home/agent/.config/git"],
    [avmMirrorsDir, "/home/agent/mirrors"],
    [avmFilesDir, "/home/agent/.avm-files"],
    [bridgeBin, "/usr/local/bin/avm-bridge"],
  ];

  for (const [source, target] of fixedMounts) {
    args.push("-v", `${source}:${target}`);
  }

  // --- User volumes from config.yaml ---
  for (const volume of config.volumes) {
    const resolvedSource = volume.source.startsWith("/")
      ? volume.source
      : path.join(avmVolumesDir, volume.source);

    let resolvedTarget: string;
    if (volume.target.startsWith("/")) {
      resolvedTarget = volume.target;
    } else if (volume.target.startsWith("~/")) {
      resolvedTarget = `/home/agent/${volume.target.slice(2)}`;
    } else {
      resolvedTarget = `/home/agent/${volume.target}`;
    }

    if (!existsSync(resolvedSource)) {
      console.warn(
        `    [warn] volume source missing: ${resolvedSource} — skipping mount to ${resolvedTarget}`,
      );
      continue;
    }

    args.push("-v", `${resolvedSource}:${resolvedTarget}`);
  }

  return args;
}
