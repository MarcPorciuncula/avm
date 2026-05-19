import { defineCommand } from "citty";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { avmVolumesDir } from "../../lib/config.ts";
import {
  loadAvmConfig,
  setConfigIntegration,
  setNotificationsEnabled,
} from "../../lib/config-file.ts";
import {
  installHooks,
  uninstallHooks,
  countAvmEntries,
  type ClaudeSettings,
} from "../../lib/notify-hooks.ts";

/**
 * Resolve a config.yaml volume target the way `getDockerMountArgs` /
 * `resolveContainerPath` in lib/session.ts does. Replicated inline rather
 * than imported because session.ts carries heavy deps and commands are
 * kept independent.
 */
function resolveContainerPath(raw: string): string {
  if (raw.startsWith("/")) return raw;
  if (raw.startsWith("~/")) return `/home/agent/${raw.slice(2)}`;
  return `/home/agent/${raw}`;
}

/**
 * The avm notify hooks must land in the in-container Claude's
 * settings.json. In the decoupled model the container's `~/.claude` is
 * backed by whichever `volumes:` entry maps to `/home/agent/.claude`.
 * Returns `<that volume's resolved host source>/settings.json`, or
 * `null` if no volume maps the container's `~/.claude`.
 */
function resolveSettingsPath(): string | null {
  const config = loadAvmConfig();
  for (const volume of config.volumes) {
    if (resolveContainerPath(volume.target) !== "/home/agent/.claude") {
      continue;
    }
    const resolvedSource = volume.source.startsWith("/")
      ? volume.source
      : join(avmVolumesDir, volume.source);
    return join(resolvedSource, "settings.json");
  }
  return null;
}

const NO_TARGET_MESSAGE =
  "avm notify hooks must land in the in-container Claude's settings.json,\n" +
  "but no config.yaml volume maps the container's ~/.claude. The hooks run\n" +
  "`avm-bridge`, which only exists inside an avm sandbox — they have no\n" +
  "effect (and would error) anywhere else, so this command refuses to\n" +
  "write to a host-side $HOME/.claude.\n" +
  "\n" +
  "Declare a volume that backs the container's ~/.claude in\n" +
  "~/.avm/config.yaml, e.g.:\n" +
  "\n" +
  "  volumes:\n" +
  "    - claude:~/.claude\n" +
  "\n" +
  "(see examples/config.yaml). Then re-run this command.";

function loadSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, "utf-8");
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ClaudeSettings;
    return {};
  } catch (err) {
    throw new Error(
      `Could not parse ${settingsPath} as JSON: ${(err as Error).message}\n` +
        `Refusing to overwrite. Fix the file by hand and re-run.`,
    );
  }
}

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/** Print a settings-load/write error with the original message and exit 1. Use for install/uninstall. */
function reportSettingsError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
}

const installSub = defineCommand({
  meta: {
    name: "install",
    description: "Install host-notification hooks into the in-container Claude settings.",
  },
  async run() {
    const settingsPath = resolveSettingsPath();
    if (settingsPath === null) {
      console.error(NO_TARGET_MESSAGE);
      process.exit(1);
    }
    let settings: ClaudeSettings;
    try {
      settings = loadSettings(settingsPath);
    } catch (err) {
      reportSettingsError(err);
    }
    const next = installHooks(settings);
    try {
      writeSettings(settingsPath, next);
    } catch (err) {
      reportSettingsError(err);
    }
    setConfigIntegration("claude_notifications", true);
    console.log(`Installed avm notification hooks in ${settingsPath}.`);
    console.log("Open the avm container and run `claude` — Notification and Stop will ping the host.");
  },
});

const uninstallSub = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove host-notification hooks from the in-container Claude settings.",
  },
  async run() {
    const settingsPath = resolveSettingsPath();
    if (settingsPath === null) {
      console.error(NO_TARGET_MESSAGE);
      process.exit(1);
    }
    let settings: ClaudeSettings;
    try {
      settings = loadSettings(settingsPath);
    } catch (err) {
      reportSettingsError(err);
    }
    const before = countAvmEntries(settings);

    if (before === 0) {
      console.log(`No avm hook entries found in ${settingsPath}. Nothing to uninstall.`);
      setConfigIntegration("claude_notifications", false);
      return;
    }

    const next = uninstallHooks(settings);
    try {
      writeSettings(settingsPath, next);
    } catch (err) {
      reportSettingsError(err);
    }
    setConfigIntegration("claude_notifications", false);
    console.log(`Removed ${before} avm hook entr${before === 1 ? "y" : "ies"} from ${settingsPath}.`);
  },
});

const muteSub = defineCommand({
  meta: {
    name: "mute",
    description: "Disable host notifications without uninstalling hooks.",
  },
  async run() {
    setNotificationsEnabled(false);
    console.log("Notifications muted (notifications.enabled: false in ~/.avm/config.yaml).");
  },
});

const unmuteSub = defineCommand({
  meta: {
    name: "unmute",
    description: "Re-enable host notifications.",
  },
  async run() {
    setNotificationsEnabled(true);
    console.log("Notifications unmuted (notifications.enabled: true in ~/.avm/config.yaml).");
  },
});

function printStatus(): void {
  let settingsPath: string | null;
  try {
    settingsPath = resolveSettingsPath();
  } catch {
    // Config invalid/unreadable — treat as no resolvable target; the
    // config-dependent block below reports the underlying error.
    settingsPath = null;
  }

  if (settingsPath === null) {
    console.log("Settings file:   (none — no volume maps ~/.claude)");
  } else {
    let settings: ClaudeSettings;
    let parseError: string | null = null;
    try {
      settings = loadSettings(settingsPath);
    } catch (err) {
      settings = {};
      parseError = (err as Error).message;
    }
    const installed = countAvmEntries(settings);
    console.log(`Hook install:    ${installed > 0 ? `installed (${installed} entr${installed === 1 ? "y" : "ies"})` : "not installed"}`);
    if (parseError) console.log(`                 ${parseError}`);
    console.log(`Settings file:   ${settingsPath}`);
  }

  // Config-dependent: integration flag, master switch + sounds.
  try {
    const config = loadAvmConfig();
    console.log(`claude_notifications: ${config.integrations.claude_notifications}`);
    console.log(`Master switch:   notifications.enabled = ${config.notifications.enabled}`);
    console.log(`Sound — needs-attention: ${config.notifications.sounds["needs-attention"].file} @ ${config.notifications.sounds["needs-attention"].volume}`);
    console.log(`Sound — complete:        ${config.notifications.sounds.complete.file} @ ${config.notifications.sounds.complete.volume}`);
  } catch (err) {
    console.log(`Master switch:   (could not load ~/.avm/config.yaml: ${(err as Error).message})`);
  }
}

const statusSub = defineCommand({
  meta: {
    name: "status",
    description: "Show notification install state, mute state, and sound config.",
  },
  async run() {
    printStatus();
  },
});

export const notifyCommand = defineCommand({
  meta: {
    name: "notify",
    description: "Manage host-notification hooks for in-container Claude Code.",
  },
  subCommands: {
    install: installSub,
    uninstall: uninstallSub,
    status: statusSub,
    mute: muteSub,
    unmute: unmuteSub,
  },
  async run() {
    // Default: status.
    printStatus();
  },
});
