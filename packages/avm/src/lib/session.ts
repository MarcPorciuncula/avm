import { $, path } from "zx";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHostContainerClient } from "@avm/shared/host-client";
import {
  AVM_HOME,
  avmDaemonDir,
  avmDaemonHostSecretFile,
  avmDaemonLogFile,
  avmFilesDir,
  avmMirrorsDir,
  avmSystemClaudeDir,
  avmSystemClaudeJsonFile,
  avmSystemClaudeMdFile,
  avmSystemDir,
  avmSystemGitConfigFile,
  avmSystemSshDir,
  avmVolumesDir,
} from "./config.ts";
import { type AvmConfig, loadAvmConfig, generateAvmLinkScript } from "./config-file.ts";

const distDir = dirname(fileURLToPath(import.meta.url));
const daemonBin = join(distDir, "avm-daemon.mjs");
const bridgeBin = join(distDir, "avm-bridge.mjs");

/**
 * Ensure the avm daemon is running and return its port and host secret.
 * If the daemon is not reachable, spawns it as a detached background process
 * and polls until it becomes reachable (up to 5 seconds).
 */
export async function ensureDaemonRunning(): Promise<{ port: number; secret: string }> {
  const config = loadAvmConfig();
  const port = config.daemon.port;

  const isReachable = async (): Promise<boolean> => {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return true;
    } catch {
      return false;
    }
  };

  if (!(await isReachable())) {
    // Ensure daemon directory exists for log file
    mkdirSync(avmDaemonDir, { recursive: true });

    const logFd = openSync(avmDaemonLogFile, "a");
    const child = spawn("node", [daemonBin], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();

    // Poll for up to 5 seconds
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (await isReachable()) break;
    }

    if (!(await isReachable())) {
      throw new Error(
        `Daemon failed to start within 5s. Check ${avmDaemonLogFile} for details.`,
      );
    }
  }

  const secret = readFileSync(avmDaemonHostSecretFile, "utf-8").trim();
  return { port, secret };
}

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
    path.dirname(avmSystemGitConfigFile),
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
  if (!existsSync(avmSystemGitConfigFile)) {
    writeFileSync(avmSystemGitConfigFile, "");
  }

  // Generate the root-level CLAUDE.md (always overwritten — avm owns this file).
  const config = loadAvmConfig();
  generateRootClaudeMd(config);
}

/**
 * Post-creation setup that copies files into a container via `docker cp`
 * and `docker exec`. Called after `docker run` or `docker start`.
 *
 * 1. Symlinks image-shipped skills into ~/.claude/skills/.
 * 2. Generates and installs the avm-link script.
 */
export async function applyPostCreationSetup(
  containerName: string,
  config: AvmConfig,
): Promise<void> {
  // --- Symlink image-shipped skills into ~/.claude/skills/ ---
  await $`docker exec ${containerName} bash -c ${
    "mkdir -p /home/agent/.claude/skills && " +
    "for d in /opt/avm/skills/*/; do " +
    'ln -sfn "$d" /home/agent/.claude/skills/$(basename "$d"); ' +
    "done"
  }`;

  // --- Generate and install avm-link ---
  const script = generateAvmLinkScript(config);
  const tempFile = "avm-link-tmp.sh";
  writeFileSync(tempFile, script);
  try {
    await $`docker cp ${tempFile} ${containerName}:/usr/local/bin/avm-link`;
    await $`docker exec -u root ${containerName} chmod +x /usr/local/bin/avm-link`;
  } finally {
    unlinkSync(tempFile);
  }

  // --- Make avm-bridge executable ---
  await $`docker exec -u root ${containerName} chmod +x /usr/local/bin/avm-bridge`;
}

/**
 * Generate the root-level `~/CLAUDE.md` that every container sees.
 * Written to `~/.avm/system/CLAUDE.md` on the host and bind-mounted
 * into containers — updates propagate to running containers immediately.
 *
 * Content: static avm agent guidance pointing the agent at the
 * relevant skills, plus a dynamic listing of declared host services
 * so the agent is ambiently aware of what's available.
 */
export function generateRootClaudeMd(config: AvmConfig): void {
  const lines = [
    "# avm Agent Environment",
    "",
    "You are running inside an `avm` sandbox — a Docker container with full",
    "autonomy. Only explicitly mounted paths from the host are visible.",
    "",
    "Do your work in `~/work/`. To clone repos, consult the avm-repos skill",
    "before continuing. To use Docker, consult the avm-docker skill before",
    "continuing. To use host services, consult the avm-services skill.",
    "When the user asks you to open a file in their editor, consult the",
    "avm-editor skill.",
    "",
    "You have free reign over this sandbox, but exercise care with anything",
    "that touches external systems — pushing to GitHub, running CLIs or MCPs",
    "that interact with external services, etc.",
    "",
    "The container filesystem persists across stop/start but is destroyed on",
    "cleanup. Only remote commits are durable.",
  ];

  const serviceEntries = Object.entries(config.services);
  if (serviceEntries.length > 0) {
    lines.push("");
    lines.push("## Host services");
    lines.push("");
    lines.push("The following services are available on the host via `avm-bridge`.");
    lines.push("Consult the avm-services skill for usage.");
    lines.push("");
    for (const [name, svc] of serviceEntries) {
      lines.push(`- **${name}** — \`${svc.check.tcp}\``);
    }
  }

  lines.push("");

  writeFileSync(avmSystemClaudeMdFile, lines.join("\n"));
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
    [avmSystemGitConfigFile, "/home/agent/.gitconfig"],
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
