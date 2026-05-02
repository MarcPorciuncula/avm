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
import { readState, updateState } from "./state.ts";

const claudeSettingsFile = join(os.homedir(), ".claude", "settings.json");

/** Matches avm-generated container names: `avm-` + 5 lowercase hex/alnum chars. */
const AVM_OWNED_ID_RE = /^avm-[a-z0-9]{5}$/;

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
 * Render the desktop SSH-config entry for a single VM. Returns null if the
 * VM has no SSH port assigned, or if the name doesn't match the auto-generated
 * `avm-<5char>` shape we treat as owned.
 */
export function renderDesktopEntry(vm: VmInfo): SshConfigEntry | null {
  if (vm.sshPort == null) return null;
  if (!AVM_OWNED_ID_RE.test(vm.name)) return null;
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
  return (
    typeof entry === "object" &&
    entry !== null &&
    "id" in entry &&
    typeof (entry as { id: unknown }).id === "string" &&
    AVM_OWNED_ID_RE.test((entry as { id: string }).id)
  );
}

/** Re-converge `~/.claude/settings.json` `sshConfigs` with current avm containers. */
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
}

export interface InstallDesktopResult {
  status: "installed" | "already";
}

/**
 * Sync first, then flip the install flag — if the sync throws, the user
 * retries cleanly and gets the canonical "installed" status.
 */
export async function installDesktopConfig(): Promise<InstallDesktopResult> {
  const before = readState().desktopConfig?.installPrompt;
  await syncDesktopConfig();
  updateState({ desktopConfig: { installPrompt: "installed" } });
  return { status: before === "installed" ? "already" : "installed" };
}

export interface UninstallDesktopResult {
  status: "uninstalled" | "not-installed";
}

/**
 * Drop avm-owned entries from `sshConfigs`, clear the install flag.
 * Leaves the rest of settings.json (other keys, non-avm sshConfigs) intact.
 */
export async function uninstallDesktopConfig(): Promise<UninstallDesktopResult> {
  let dropped = 0;
  if (existsSync(claudeSettingsFile)) {
    const settings = readSettings();
    const existing = settings.sshConfigs ?? [];
    const preserved = existing.filter((e) => !isAvmOwnedEntry(e));
    dropped = existing.length - preserved.length;
    if (dropped > 0) {
      settings.sshConfigs = preserved;
      writeSettings(settings);
    }
  }
  updateState({ desktopConfig: { installPrompt: undefined } });
  return { status: dropped > 0 ? "uninstalled" : "not-installed" };
}
