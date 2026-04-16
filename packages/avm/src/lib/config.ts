import { path } from "zx";
import os from "node:os";
import { readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const AVM_LABEL = "avm=true";
export const SSH_PORT_LABEL = "avm.ssh-port";
export const CORE_IMAGE = "avm-core";
export const USER_IMAGE = "avm";

/** Map a 5-char container ID to a deterministic SSH port in 22000–22999. */
export function sshPortForId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return 22000 + (((hash % 1000) + 1000) % 1000);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

// --- ~/.avm/ layout ---

export const AVM_HOME = path.join(os.homedir(), ".avm");

export const avmSystemDir = path.join(AVM_HOME, "system");
export const avmSystemSshDir = path.join(avmSystemDir, "credentials/ssh");
export const avmSystemGitConfigFile = path.join(
  avmSystemDir,
  "credentials/git/.gitconfig",
);
export const avmSystemClaudeDir = path.join(avmSystemDir, "claude");
export const avmSystemClaudeJsonFile = path.join(avmSystemDir, "claude.json");

export const avmMirrorsDir = path.join(AVM_HOME, "mirrors");
export const avmVolumesDir = path.join(AVM_HOME, "volumes");
export const avmFilesDir = path.join(AVM_HOME, "files");

export const avmConfigFile = path.join(AVM_HOME, "config.yaml");
export const avmSshConfigFile = path.join(AVM_HOME, "ssh_config");
export const avmStateFile = path.join(AVM_HOME, "state.json");

export const avmDaemonDir = path.join(AVM_HOME, "daemon");
export const avmDaemonStateFile = path.join(avmDaemonDir, "state.json");
export const avmDaemonPidFile = path.join(avmDaemonDir, "daemon.pid");
export const avmDaemonLogFile = path.join(avmDaemonDir, "daemon.log");
export const avmDaemonHostSecretFile = path.join(avmDaemonDir, "host.secret");
export const DEFAULT_DAEMON_PORT = 6970;

/**
 * Detect the host IANA timezone (e.g. "Australia/Sydney") by reading the
 * /etc/localtime symlink. Returns undefined if detection fails.
 */
export function getHostTimezone(): string | undefined {
  try {
    const target = readlinkSync("/etc/localtime");
    const marker = "zoneinfo/";
    const idx = target.indexOf(marker);
    if (idx !== -1) {
      return target.slice(idx + marker.length);
    }
  } catch {
    // /etc/localtime missing or not a symlink
  }
  return process.env.TZ || undefined;
}
