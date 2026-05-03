import { defineCommand } from "citty";
import { select, isCancel } from "@clack/prompts";
import {
  installInclude,
  syncHostIntegrations,
  uninstallInclude,
} from "../../lib/ssh-config.ts";
import {
  installDesktopConfig,
  uninstallDesktopConfig,
} from "../../lib/desktop-config.ts";
import { readState, updateState } from "../../lib/state.ts";

const syncSub = defineCommand({
  meta: {
    name: "sync",
    description:
      "Regenerate ~/.avm/ssh_config and (if installed) ~/.claude/settings.json sshConfigs.",
  },
  async run() {
    await syncHostIntegrations();
    console.log("Wrote ~/.avm/ssh_config.");
  },
});

const installSub = defineCommand({
  meta: {
    name: "install",
    description:
      "Add an Include to ~/.ssh/config and (optionally) register avm containers in the Claude desktop app.",
  },
  args: {
    desktop: {
      type: "boolean",
      description:
        "Also register avm containers in ~/.claude/settings.json. Skips the prompt.",
    },
    "no-desktop": {
      type: "boolean",
      description:
        "Don't register avm containers in ~/.claude/settings.json. Skips the prompt.",
    },
  },
  async run({ args }) {
    if (args.desktop && args["no-desktop"]) {
      console.error(
        "Error: --desktop and --no-desktop are mutually exclusive.",
      );
      process.exit(1);
    }

    // 1. Existing SSH-config install (unchanged behaviour).
    const sshResult = await installInclude();
    updateState({ sshConfig: { installPrompt: "installed" } });
    if (sshResult.status === "installed") {
      console.log("Installed Include in ~/.ssh/config.");
      console.log("You can now run: ssh avm-<id>");
    } else {
      console.log("Already installed — ~/.ssh/config already includes avm's config.");
    }

    // 2. Decide on desktop side.
    let wantDesktop: boolean | null = null;
    if (args.desktop) wantDesktop = true;
    else if (args["no-desktop"]) wantDesktop = false;

    if (wantDesktop === null) {
      const state = readState();
      if (state.desktopConfig?.installPrompt === undefined) {
        const choice = await select({
          message:
            "Also register avm containers in the Claude desktop app's environment dropdown? (writes to ~/.claude/settings.json)",
          options: [
            { value: "yes", label: "Yes, install it" },
            { value: "later", label: "Not now (ask again next time)" },
            { value: "never", label: "No, don't ask again" },
          ],
          initialValue: "yes",
        });
        if (isCancel(choice)) return;
        if (choice === "yes") wantDesktop = true;
        else if (choice === "never") {
          updateState({ desktopConfig: { installPrompt: "declined" } });
          wantDesktop = false;
        } else {
          // "later" — leave state undefined so we ask again next time.
          wantDesktop = false;
        }
      } else {
        // Already answered. Honour previous answer.
        wantDesktop = state.desktopConfig?.installPrompt === "installed";
      }
    }

    if (wantDesktop) {
      const desktopResult = await installDesktopConfig();
      if (desktopResult.status === "installed") {
        console.log(
          "Registered avm containers in ~/.claude/settings.json (sshConfigs).",
        );
      } else {
        console.log(
          "Already registered — ~/.claude/settings.json already lists avm containers.",
        );
      }
    }
  },
});

const uninstallSub = defineCommand({
  meta: {
    name: "uninstall",
    description:
      "Remove the avm-managed Include from ~/.ssh/config and avm entries from ~/.claude/settings.json.",
  },
  async run() {
    const sshResult = await uninstallInclude();
    updateState({ sshConfig: { installPrompt: undefined } });
    if (sshResult.status === "uninstalled") {
      console.log("Removed avm Include block from ~/.ssh/config.");
    } else {
      console.log("Nothing to uninstall — no avm Include block found.");
    }

    const state = readState();
    if (state.desktopConfig?.installPrompt === "installed") {
      const desktopResult = await uninstallDesktopConfig();
      if (desktopResult.status === "uninstalled") {
        console.log("Removed avm entries from ~/.claude/settings.json.");
      } else {
        console.log("No avm entries found in ~/.claude/settings.json.");
      }
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
    await syncHostIntegrations();
    console.log("Wrote ~/.avm/ssh_config.");
  },
});
