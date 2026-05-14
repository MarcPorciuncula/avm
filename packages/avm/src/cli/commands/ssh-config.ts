import { defineCommand } from "citty";
import {
  installInclude,
  syncHostIntegrations,
  uninstallInclude,
} from "../../lib/ssh-config.ts";
import {
  installDesktopConfig,
  syncDesktopConfig,
  uninstallDesktopConfig,
} from "../../lib/desktop-config.ts";
import {
  loadAvmConfig,
  setConfigIntegration,
} from "../../lib/config-file.ts";
import { updateState } from "../../lib/state.ts";

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
        "Also register avm containers in ~/.claude/settings.json. Use --no-desktop to opt out. These flags only control the desktop side; the SSH-config Include is always installed. Either form flips integrations.claude_desktop in ~/.avm/config.yaml.",
    },
  },
  async run({ args }) {
    // parseArgs treats --no-X as the negation of --X, so --desktop and
    // --no-desktop both map to args.desktop (true/false). Absence is undefined.
    const desktopFlag: boolean | undefined =
      typeof args.desktop === "boolean" ? args.desktop : undefined;

    // Always install the SSH-config Include first; the desktop flag only
    // controls the desktop add-on that follows.
    const sshResult = await installInclude();
    updateState({ sshConfig: { installPrompt: "installed" } });
    if (sshResult.status === "installed") {
      console.log("Installed Include in ~/.ssh/config.");
      console.log("You can now run: ssh avm-<id>");
    } else {
      console.log("Already installed — ~/.ssh/config already includes avm's config.");
    }

    if (desktopFlag === true) {
      await installDesktopConfig();
      console.log(
        "Set integrations.claude_desktop: true in ~/.avm/config.yaml and wrote ~/.claude/settings.json.",
      );
      return;
    }

    if (desktopFlag === false) {
      setConfigIntegration("claude_desktop", false);
      console.log(
        "Set integrations.claude_desktop: false in ~/.avm/config.yaml.",
      );
      return;
    }

    // Neither flag passed: honour the current config flag — sync if it's
    // on, do nothing extra if it's off. Don't modify the flag itself.
    const config = loadAvmConfig();
    if (config.integrations.claude_desktop) {
      await syncDesktopConfig();
      console.log("Synced avm containers into ~/.claude/settings.json.");
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

    // Always run the desktop uninstall — it's idempotent and total, so it
    // cleans up any avm-owned entries even if the integration flag was
    // hand-edited to false while entries still exist in settings.json.
    await uninstallDesktopConfig();
    console.log(
      "Cleared integrations.claude_desktop and removed avm entries from ~/.claude/settings.json.",
    );
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
  // No subcommand → dispatch to sync. citty 0.2.2 fires both the matched
  // subcommand and the parent's `run` (causing duplicate output), so use
  // `default` instead of a parent `run` to express the fallback.
  default: "sync",
});
