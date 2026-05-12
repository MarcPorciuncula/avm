import { $, path } from "zx";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHostContainerClient } from "@avm/shared/host-client";
import {
  AVM_HOME,
  REPO_ROOT,
  avmAgentsMdFile,
  avmFilesDir,
  avmMirrorsDir,
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
 * Ensure host-side `~/.avm/` scaffolding exists so docker volume mounts
 * don't fail on missing source dirs. Creates the standard subdirectories,
 * migrates any legacy `~/.avm/system/` layout to the new flat layout,
 * and (re)generates `~/.avm/AGENTS.md` from the current config.
 */
export function ensureHostScaffolding(): void {
  const requiredDirs = [
    avmMirrorsDir,
    avmVolumesDir,
    avmFilesDir,
    path.join(AVM_HOME, "build-context"),
  ];
  for (const dir of requiredDirs) {
    mkdirSync(dir, { recursive: true });
  }
  migrateLegacyLayout();
  const config = loadAvmConfig();
  generateAgentsMd(config);
}

type LegacyMove = {
  src: string;
  dst: string;
  /** Volume-line representation used in the migration hint snippet (`- name:target`). */
  volumeLine: string;
};

function migrateLegacyLayout(): void {
  const legacySystem = path.join(AVM_HOME, "system");
  if (!existsSync(legacySystem)) return;

  const moves: LegacyMove[] = [
    {
      src: path.join(legacySystem, "credentials", "ssh"),
      dst: path.join(avmVolumesDir, "ssh"),
      volumeLine: "- ssh:~/.ssh",
    },
    {
      src: path.join(legacySystem, "credentials", "git"),
      dst: path.join(avmVolumesDir, "git"),
      volumeLine: "- git:~/.config/git",
    },
    {
      src: path.join(legacySystem, "claude"),
      dst: path.join(avmVolumesDir, "claude"),
      volumeLine: "- claude:~/.claude",
    },
    {
      src: path.join(legacySystem, "claude.json"),
      dst: path.join(avmVolumesDir, "claude.json"),
      volumeLine: "- claude.json:~/.claude.json",
    },
  ];

  const collisions: { src: string; dst: string }[] = [];
  for (const m of moves) {
    if (existsSync(m.src)) {
      if (existsSync(m.dst)) {
        console.log(
          `    [migrate] ${m.dst} already exists — skipped move of ${m.src}`,
        );
        collisions.push({ src: m.src, dst: m.dst });
      } else {
        mkdirSync(path.dirname(m.dst), { recursive: true });
        renameSync(m.src, m.dst);
        console.log(`    [migrate] ${m.src} → ${m.dst}`);
      }
    }
  }

  // Old CLAUDE.md is regenerated as AGENTS.md by ensureHostScaffolding —
  // delete the legacy file so it doesn't linger.
  const legacyClaudeMd = path.join(legacySystem, "CLAUDE.md");
  if (existsSync(legacyClaudeMd)) {
    rmSync(legacyClaudeMd);
  }

  // Best-effort cleanup of now-empty legacy dirs.
  try {
    rmdirSync(path.join(legacySystem, "credentials"));
  } catch {
    // Not empty or already gone — ignore.
  }
  try {
    rmdirSync(legacySystem);
  } catch {
    // Not empty or already gone — ignore.
  }

  printMigrationHintIfNeeded(moves);
  printCollisionNoticeIfNeeded(collisions);
}

function printCollisionNoticeIfNeeded(
  collisions: { src: string; dst: string }[],
): void {
  if (collisions.length === 0) return;
  // Compute a column width so the "(legacy)" / "(new — will be used)"
  // annotations line up regardless of path lengths.
  const width = Math.max(...collisions.map((c) => c.src.length), ...collisions.map((c) => c.dst.length));
  console.log();
  console.log(
    "==> Legacy data left in place — both paths exist:",
  );
  for (const c of collisions) {
    console.log(`      ${c.src.padEnd(width)}  (legacy)`);
    console.log(`      ${c.dst.padEnd(width)}  (new — will be used)`);
  }
  console.log(
    "    Inspect the legacy path and either delete it, or move its contents",
  );
  console.log("    into the new path manually.");
  console.log();
}

function printMigrationHintIfNeeded(allMoves: LegacyMove[]): void {
  // Determine which moves landed (dst exists, regardless of whether we
  // moved it just now or in a previous run).
  const landed = allMoves.filter((m) => existsSync(m.dst));
  if (landed.length === 0) return;

  const config = loadAvmConfig();
  const declaredSources = new Set(
    config.volumes.map((v) => v.source.replace(/^\/+/, "")),
  );
  const undeclared = landed.filter((m) => {
    // m.volumeLine looks like "- ssh:~/.ssh"; the source token is "ssh".
    const source = m.volumeLine.replace(/^- /, "").split(":")[0];
    return !declaredSources.has(source);
  });
  if (undeclared.length === 0) return;

  console.log();
  console.log(
    "==> Legacy ~/.avm/system layout detected. Files moved to ~/.avm/volumes.",
  );
  console.log(
    "    Declare them in ~/.avm/config.yaml to restore previous behaviour:",
  );
  console.log();
  console.log("      agents_md: ~/CLAUDE.md");
  console.log("      skills_dir: ~/.claude/skills");
  console.log("      volumes:");
  for (const m of undeclared) {
    console.log(`        ${m.volumeLine}`);
  }
  console.log("      integrations:");
  console.log(
    "        claude_notifications: true   # if previously enabled",
  );
  console.log(
    "        claude_desktop: true         # if previously enabled",
  );
  console.log();
  console.log("    Or copy examples/config.yaml as a starting point.");
  console.log();
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
 * Generate the host-side `~/.avm/AGENTS.md` that every container sees
 * mounted to each path declared in `config.agents_md`. Updates propagate
 * to running containers immediately.
 *
 * Static content comes from `templates/agents.md`. This function appends
 * dynamic sections (e.g. host services listing).
 */
export function generateAgentsMd(config: AvmConfig): void {
  const template = readFileSync(
    join(REPO_ROOT, "templates", "agents.md"),
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

  writeFileSync(avmAgentsMdFile, parts.join("\n"));
}

/**
 * Build the `-v` flag array for `docker run`. Encodes the fixed avm
 * machinery mounts, the generated AGENTS.md mounted to each target in
 * `config.agents_md`, and user-configured volumes from config.yaml.
 *
 * Returns a flat array like `["-v", "src:dst", "-v", "src:dst", ...]`.
 */
export function getDockerMountArgs(config: AvmConfig): string[] {
  const args: string[] = [];

  // Fixed avm-machinery mounts.
  args.push("-v", `${bridgeBin}:/usr/local/bin/avm-bridge`);
  args.push("-v", `${avmMirrorsDir}:/home/agent/mirrors`);
  args.push("-v", `${avmFilesDir}:/home/agent/.avm-files`);

  // Generated guidance file mounted to each configured target.
  for (const target of config.agents_md) {
    args.push("-v", `${avmAgentsMdFile}:${resolveContainerPath(target)}`);
  }

  // User-declared volumes.
  for (const volume of config.volumes) {
    const resolvedSource = volume.source.startsWith("/")
      ? volume.source
      : path.join(avmVolumesDir, volume.source);
    const resolvedTarget = resolveContainerPath(volume.target);
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

function resolveContainerPath(raw: string): string {
  if (raw.startsWith("/")) return raw;
  if (raw.startsWith("~/")) return `/home/agent/${raw.slice(2)}`;
  return `/home/agent/${raw}`;
}
