import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { listAvmVms, type VmInfo } from "./vm.ts";
import { setConfigIntegration } from "./config-file.ts";
import {
  reconcileKnownHosts,
  removeManagedKnownHosts,
} from "./known-hosts.ts";

const claudeSettingsFile = join(os.homedir(), ".claude", "settings.json");

const DESKTOP_START_DIRECTORY = "~/work";

export interface SshConfigEntry {
  id: string;
  name: string;
  sshHost: string;
  sshPort?: number;
  sshIdentityFile?: string;
  startDirectory?: string;
}

interface ClaudeSettings {
  sshConfigs?: SshConfigEntry[];
  [key: string]: unknown;
}

/**
 * Render the desktop SSH-config entry for a single VM. `listAvmVms()` only
 * returns containers with avm's Docker label, so both auto-generated and
 * user-provided names are safe to register here.
 */
export function renderDesktopEntry(vm: VmInfo): SshConfigEntry | null {
  if (vm.sshPort == null) return null;
  return {
    id: vm.name,
    name: vm.name,
    sshHost: vm.name,
    startDirectory: DESKTOP_START_DIRECTORY,
  };
}

function readSettings(): ClaudeSettings {
  if (!existsSync(claudeSettingsFile)) return {};
  const raw = readFileSync(claudeSettingsFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Refusing to overwrite ${claudeSettingsFile} — file is not valid JSON: ${
        (err as Error).message
      }. Fix or remove the file, then re-run.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Refusing to overwrite ${claudeSettingsFile} — top-level value is not a JSON object.`,
    );
  }
  const settings = parsed as ClaudeSettings;
  if (settings.sshConfigs !== undefined && !Array.isArray(settings.sshConfigs)) {
    throw new Error(
      `Refusing to overwrite ${claudeSettingsFile} — \`sshConfigs\` exists but is not an array.`,
    );
  }
  return settings;
}

function writeSettings(settings: ClaudeSettings): void {
  mkdirSync(dirname(claudeSettingsFile), { recursive: true, mode: 0o700 });
  const tmp = `${claudeSettingsFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, claudeSettingsFile);
}

function isAvmOwnedEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;

  const candidate = entry as Partial<SshConfigEntry>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.startsWith("avm-") &&
    candidate.id.length > "avm-".length &&
    candidate.name === candidate.id &&
    candidate.sshHost === candidate.id &&
    candidate.startDirectory === DESKTOP_START_DIRECTORY
  );
}

/**
 * Re-converge `~/.claude/settings.json` `sshConfigs` with current avm
 * containers, and reconcile `~/.ssh/known_hosts` so the desktop app's SSH
 * client can verify the containers' host keys (see `known-hosts.ts` — the
 * desktop client ignores the `StrictHostKeyChecking no` /
 * `UserKnownHostsFile /dev/null` directives that make `avm ssh` work).
 */
export async function syncDesktopConfig(): Promise<void> {
  const settings = readSettings();
  const existing = settings.sshConfigs ?? [];
  const preserved = existing.filter((e) => !isAvmOwnedEntry(e));

  const vms = await listAvmVms();
  const fresh = vms
    .map(renderDesktopEntry)
    .filter((e): e is SshConfigEntry => e !== null);

  settings.sshConfigs = [...preserved, ...fresh];
  writeSettings(settings);

  await reconcileKnownHosts(vms);
}

/**
 * Set `integrations.claude_desktop: true` in config.yaml and sync
 * `~/.claude/settings.json` so the user's desktop sees current containers.
 */
export async function installDesktopConfig(): Promise<void> {
  setConfigIntegration("claude_desktop", true);
  await syncDesktopConfig();
}

/**
 * Drop avm-owned entries from `~/.claude/settings.json` (uninstall is total),
 * remove avm's managed block from `~/.ssh/known_hosts`, and clear
 * `integrations.claude_desktop` in config.yaml. Leaves the rest of
 * settings.json (other keys, non-avm sshConfigs) and known_hosts intact.
 */
export async function uninstallDesktopConfig(): Promise<void> {
  if (existsSync(claudeSettingsFile)) {
    const settings = readSettings();
    const existing = settings.sshConfigs ?? [];
    const preserved = existing.filter((e) => !isAvmOwnedEntry(e));
    if (existing.length - preserved.length > 0) {
      settings.sshConfigs = preserved;
      writeSettings(settings);
    }
  }
  removeManagedKnownHosts();
  setConfigIntegration("claude_desktop", false);
}
