import { $, path } from "zx";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
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
import { type AvmConfig, generateAvmLinkScript } from "./config-file.ts";

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

  // The bind mount for ~/.claude.json is a file mount, so the file has to
  // exist on both sides. Seed with `{}` so Claude Code sees valid JSON.
  if (!existsSync(avmSystemClaudeJsonFile)) {
    writeFileSync(avmSystemClaudeJsonFile, "{}\n");
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
 * Post-creation setup that copies files into a container via `docker cp`
 * and `docker exec`. Called after `docker run` or `docker start`.
 *
 * 1. Copies .gitconfig into the container (skips with warning if missing).
 * 2. Generates and installs the avm-link script.
 */
export async function applyPostCreationSetup(
  containerName: string,
  config: AvmConfig,
): Promise<void> {
  // --- Copy .gitconfig ---
  if (existsSync(avmSystemGitConfigFile)) {
    await $`docker cp ${avmSystemGitConfigFile} ${containerName}:/home/agent/.gitconfig`;
    await $`docker exec -u root ${containerName} chown agent:agent /home/agent/.gitconfig`;
  } else {
    console.warn(
      "    [warn] no ~/.avm/system/credentials/git/.gitconfig — skipping .gitconfig copy",
    );
  }

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
    [avmMirrorsDir, "/home/agent/mirrors"],
    [avmFilesDir, "/home/agent/.avm-files"],
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
