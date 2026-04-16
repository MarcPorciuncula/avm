import { defineCommand } from "citty";
import { $ } from "zx";
import { select, isCancel } from "@clack/prompts";
import { loadAvmConfig } from "../../lib/config-file.ts";
import { USER_IMAGE, AVM_LABEL, SSH_PORT_LABEL, getHostTimezone, sshPortForId } from "../../lib/config.ts";
import { openInEditor, resolveEditorCli } from "../../lib/editor.ts";
import { installInclude, syncSshConfig } from "../../lib/ssh-config.ts";
import { readState, updateState } from "../../lib/state.ts";
import {
  applyPostCreationSetup,
  ensureHostScaffolding,
  getDockerMountArgs,
  registerContainer,
} from "../../lib/session.ts";
import {
  attachToVm,
  ensureSshd,
  generateSessionName,
  listAvmVms,
  normalizeVmName,
  shortIdOf,
  sshToVm,
} from "../../lib/vm.ts";

export const createCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create and start a new agent container.",
  },
  args: {
    name: {
      type: "positional",
      required: false,
      description:
        "Suffix for the container name (avm- is prepended automatically). Random if omitted.",
    },
    attach: {
      type: "boolean",
      description: "After setup, attach to the container.",
    },
    editor: {
      type: "boolean",
      description: "After setup, open the container in your editor.",
    },
    ssh: {
      type: "boolean",
      description: "After setup, connect via SSH instead of docker exec.",
    },
  },
  async run({ args }) {
    if (args.attach && args.ssh) {
      console.error("Error: --attach and --ssh are mutually exclusive.");
      process.exit(1);
    }

    const vmName = args.name
      ? normalizeVmName(args.name)
      : generateSessionName();

    const existing = await listAvmVms();
    if (existing.some((v) => v.name === vmName)) {
      console.error(
        `Error: Container ${vmName} already exists. ` +
          `Use 'avm start ${shortIdOf(vmName)}' to resume it, or ` +
          `'avm clean ${shortIdOf(vmName)}' to delete and recreate.`,
      );
      process.exit(1);
    }

    ensureHostScaffolding();

    let config;
    try {
      config = loadAvmConfig();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }

    const mountArgs = getDockerMountArgs(config);

    const tz = getHostTimezone();
    const tzArgs = tz ? ["-e", `TZ=${tz}`] : [];

    const sshPort = sshPortForId(shortIdOf(vmName));

    console.log(`==> Registering container with daemon...`);
    const token = await registerContainer(vmName);

    console.log(`==> Creating container ${vmName}...`);
    await $`docker run -d ${[
      "--name", vmName,
      "--hostname", vmName,
      "--label", AVM_LABEL,
      "--label", `${SSH_PORT_LABEL}=${sshPort}`,
      "--network", "host",
      "--privileged",
      "--init",
      "-v", `${vmName}-docker:/var/lib/docker`,
      "-e", `AVM_ID=${shortIdOf(vmName)}`,
      "-e", `AVM_SSH_PORT=${sshPort}`,
      "-e", `AVM_HOST_PORT=${config.daemon.port}`,
      "-e", `AVM_HOST_TOKEN=${token}`,
      "-e", `AVM_CONTAINER_NAME=${vmName}`,
      ...tzArgs,
      ...mountArgs,
    ]} ${`${USER_IMAGE}:latest`} sleep infinity`;

    await applyPostCreationSetup(vmName, config);

    console.log(`==> Starting sshd in ${vmName}...`);
    await ensureSshd(vmName, sshPort);

    await syncSshConfig();

    const state = readState();
    if (state.sshConfig?.installPrompt === undefined) {
      const choice = await select({
        message:
          "Enable `ssh avm-<id>` shortcut by adding an Include to ~/.ssh/config?",
        options: [
          { value: "yes", label: "Yes, install it" },
          { value: "later", label: "Not now (ask again next time)" },
          { value: "never", label: "No, don't ask again" },
        ],
        initialValue: "yes",
      });
      if (!isCancel(choice)) {
        if (choice === "yes") {
          const result = await installInclude();
          updateState({ sshConfig: { installPrompt: "installed" } });
          if (result.status === "installed") {
            console.log("Installed Include in ~/.ssh/config.");
          } else {
            console.log("~/.ssh/config already includes avm's config.");
          }
        } else if (choice === "never") {
          updateState({ sshConfig: { installPrompt: "declined" } });
        }
        // "later" → no state change
      }
    }

    const sshInstalled =
      readState().sshConfig?.installPrompt === "installed";

    console.log();
    console.log("Session ready.");
    console.log();
    console.log(`  Attach: avm attach ${shortIdOf(vmName)}`);
    console.log(
      `  SSH:    ${sshInstalled ? `ssh ${vmName}` : `avm ssh ${shortIdOf(vmName)}`}`,
    );
    console.log();

    if (args.editor) {
      const cli = await resolveEditorCli(config);
      if (cli) openInEditor(cli, vmName);
    }

    if (args.ssh) {
      console.log(`==> Connecting via SSH...`);
      process.exit(sshToVm(sshPort));
    }

    if (args.attach) {
      console.log(`==> Attaching to ${vmName}...`);
      process.exit(attachToVm(vmName));
    }
  },
});
