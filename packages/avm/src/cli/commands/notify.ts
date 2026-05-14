import { defineCommand } from "citty";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

function loadSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  const raw = readFileSync(SETTINGS_PATH, "utf-8");
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ClaudeSettings;
    return {};
  } catch (err) {
    throw new Error(
      `Could not parse ${SETTINGS_PATH} as JSON: ${(err as Error).message}\n` +
        `Refusing to overwrite. Fix the file by hand and re-run.`,
    );
  }
}

function writeSettings(settings: ClaudeSettings): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
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
    let settings: ClaudeSettings;
    try {
      settings = loadSettings();
    } catch (err) {
      reportSettingsError(err);
    }
    const next = installHooks(settings);
    try {
      writeSettings(next);
    } catch (err) {
      reportSettingsError(err);
    }
    setConfigIntegration("claude_notifications", true);
    console.log(`Installed avm notification hooks in ${SETTINGS_PATH}.`);
    console.log("Open the avm container and run `claude` — Notification and Stop will ping the host.");
  },
});

const uninstallSub = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove host-notification hooks from the in-container Claude settings.",
  },
  async run() {
    let settings: ClaudeSettings;
    try {
      settings = loadSettings();
    } catch (err) {
      reportSettingsError(err);
    }
    const before = countAvmEntries(settings);

    if (before === 0) {
      console.log(`No avm hook entries found in ${SETTINGS_PATH}. Nothing to uninstall.`);
      setConfigIntegration("claude_notifications", false);
      return;
    }

    const next = uninstallHooks(settings);
    try {
      writeSettings(next);
    } catch (err) {
      reportSettingsError(err);
    }
    setConfigIntegration("claude_notifications", false);
    console.log(`Removed ${before} avm hook entr${before === 1 ? "y" : "ies"} from ${SETTINGS_PATH}.`);
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
  let settings: ClaudeSettings;
  let parseError: string | null = null;
  try {
    settings = loadSettings();
  } catch (err) {
    settings = {};
    parseError = (err as Error).message;
  }
  const installed = countAvmEntries(settings);

  // Config-independent diagnostics first — print regardless of config validity.
  console.log(`Hook install:    ${installed > 0 ? `installed (${installed} entr${installed === 1 ? "y" : "ies"})` : "not installed"}`);
  if (parseError) console.log(`                 ${parseError}`);
  console.log(`Settings file:   ${SETTINGS_PATH}`);

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
