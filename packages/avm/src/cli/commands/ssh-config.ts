import { defineCommand } from "citty";
import {
  installInclude,
  syncSshConfig,
  uninstallInclude,
} from "../../lib/ssh-config.ts";
import { updateState } from "../../lib/state.ts";

const syncSub = defineCommand({
  meta: {
    name: "sync",
    description: "Regenerate ~/.avm/ssh_config from current containers.",
  },
  async run() {
    await syncSshConfig();
    console.log("Wrote ~/.avm/ssh_config.");
  },
});

const installSub = defineCommand({
  meta: {
    name: "install",
    description: "Add an Include line to ~/.ssh/config (idempotent).",
  },
  async run() {
    const result = await installInclude();
    updateState({ sshConfig: { installPrompt: "installed" } });
    if (result.status === "installed") {
      console.log("Installed Include in ~/.ssh/config.");
      console.log("You can now run: ssh avm-<id>");
    } else {
      console.log("Already installed — ~/.ssh/config already includes avm's config.");
    }
  },
});

const uninstallSub = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove the avm-managed Include block from ~/.ssh/config.",
  },
  async run() {
    const result = await uninstallInclude();
    // Clear the prompt decision so a future `install` (or `create` prompt) works cleanly.
    updateState({ sshConfig: { installPrompt: undefined } });
    if (result.status === "uninstalled") {
      console.log("Removed avm Include block from ~/.ssh/config.");
    } else {
      console.log("Nothing to uninstall — no avm Include block found.");
    }
  },
});

export const sshConfigCommand = defineCommand({
  meta: {
    name: "ssh-config",
    description: "Manage the avm-generated SSH config.",
  },
  subCommands: {
    sync: syncSub,
    install: installSub,
    uninstall: uninstallSub,
  },
  // Default when called with no subcommand: sync.
  async run() {
    await syncSshConfig();
    console.log("Wrote ~/.avm/ssh_config.");
  },
});
