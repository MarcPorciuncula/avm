import { defineCommand } from "citty";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { confirm, isCancel, log } from "@clack/prompts";

import { avmSystemClaudeDir } from "../../lib/config.ts";
import { loadAvmConfig, setNotificationsEnabled } from "../../lib/config-file.ts";
import { readState, updateState } from "../../lib/state.ts";
import {
  installHooks,
  uninstallHooks,
  countAvmEntries,
  type ClaudeSettings,
} from "../../lib/notify-hooks.ts";

const SETTINGS_PATH = join(avmSystemClaudeDir, "settings.json");

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

const installSub = defineCommand({
  meta: {
    name: "install",
    description: "Install host-notification hooks into the in-container Claude settings.",
  },
  async run() {
    const settings = loadSettings();
    const next = installHooks(settings);
    writeSettings(next);
    updateState({ notifications: { installPrompt: "installed" } });
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
    const settings = loadSettings();
    const before = countAvmEntries(settings);
    const next = uninstallHooks(settings);
    writeSettings(next);
    // Clear the prompt decision so a future `provision`/`start` re-asks.
    updateState({ notifications: { installPrompt: undefined } });
    if (before === 0) {
      console.log(`No avm hook entries found in ${SETTINGS_PATH}. Nothing to uninstall.`);
    } else {
      console.log(`Removed ${before} avm hook entr${before === 1 ? "y" : "ies"} from ${SETTINGS_PATH}.`);
    }
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

  let config;
  try {
    config = loadAvmConfig();
  } catch (err) {
    console.log(`Could not load ~/.avm/config.yaml: ${(err as Error).message}`);
    return;
  }

  const state = readState();
  const promptState = state.notifications?.installPrompt ?? "(not asked)";

  console.log(`Hook install:    ${installed > 0 ? `installed (${installed} entr${installed === 1 ? "y" : "ies"})` : "not installed"}`);
  if (parseError) console.log(`                 ${parseError}`);
  console.log(`Settings file:   ${SETTINGS_PATH}`);
  console.log(`Master switch:   notifications.enabled = ${config.notifications.enabled}`);
  console.log(`Sound — needs-attention: ${config.notifications.sounds["needs-attention"].file} @ ${config.notifications.sounds["needs-attention"].volume}`);
  console.log(`Sound — complete:        ${config.notifications.sounds.complete.file} @ ${config.notifications.sounds.complete.volume}`);
  console.log(`Install prompt:  ${promptState}`);
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

/**
 * Run the first-run install prompt. No-op if the user has already answered
 * (state.notifications.installPrompt is set). Returns true if the prompt
 * was shown, false otherwise.
 */
export async function maybePromptForInstall(): Promise<boolean> {
  const state = readState();
  if (state.notifications?.installPrompt !== undefined) return false;

  const answer = await confirm({
    message:
      "AVM can play a sound and post a macOS notification when the agent needs your attention or finishes a turn. Install hooks now?\nYou can change this later with `avm notify {install,uninstall,mute,unmute}`.",
    initialValue: true,
  });

  if (isCancel(answer)) {
    // Treat cancel as "ask again next time" — don't record an answer.
    log.warn("Install prompt cancelled. AVM will ask again next time.");
    return true;
  }

  if (answer === true) {
    const settings = loadSettings();
    const next = installHooks(settings);
    writeSettings(next);
    updateState({ notifications: { installPrompt: "installed" } });
    log.success(`Installed avm notification hooks in ${SETTINGS_PATH}.`);
  } else {
    updateState({ notifications: { installPrompt: "declined" } });
    log.info("Skipped — you can install later with `avm notify install`.");
  }
  return true;
}

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
