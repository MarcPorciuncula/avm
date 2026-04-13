import { defineCommand } from "citty";
import { $ } from "zx";
import { loadAvmConfig } from "../../lib/config-file.ts";
import { openInEditor, resolveEditorCli } from "../../lib/editor.ts";
import { applyPostCreationSetup, ensureHostScaffolding } from "../../lib/session.ts";
import {
  attachToVm,
  ensureSshd,
  listAvmVms,
  resolveVmByPrefix,
  shortIdOf,
  sshToVm,
} from "../../lib/vm.ts";

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description: "Resume a stopped agent container.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Short ID (or unique prefix) of the container to resume.",
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

    if (!args.id) {
      console.error(
        "Error: avm start requires a container id. Use 'avm create' to start a new session.",
      );
      process.exit(1);
    }

    const vms = await listAvmVms();

    let vm: (typeof vms)[number];
    let vmName: string;
    let vmStatus: string;
    try {
      vm = resolveVmByPrefix(args.id, vms).vm;
      vmName = vm.name;
      vmStatus = vm.status;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      console.error(
        `Use 'avm list' to see sessions, or 'avm create <name>' to start a new one.`,
      );
      process.exit(1);
    }

    if (vmStatus === "running") {
      console.error(
        `Error: Container ${vmName} is already running. Use 'avm attach ${shortIdOf(vmName)}' to connect.`,
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

    console.log(`==> Starting ${vmName}...`);
    await $`docker start ${vmName}`;

    // Regenerate /usr/local/bin/avm-link and copy .gitconfig so
    // config.yaml changes take effect on resume.
    await applyPostCreationSetup(vmName, config);

    if (vm.sshPort) {
      console.log(`==> Starting sshd in ${vmName}...`);
      await ensureSshd(vmName, vm.sshPort);
    }

    console.log();
    console.log("Session ready.");
    console.log();
    console.log(`  Attach: avm attach ${shortIdOf(vmName)}`);
    console.log(`  SSH:    avm ssh ${shortIdOf(vmName)}`);
    console.log();

    if (args.editor) {
      const cli = await resolveEditorCli(config);
      if (cli) openInEditor(cli, vmName);
    }

    if (args.ssh) {
      if (!vm.sshPort) {
        console.error(
          `Error: Container ${vmName} has no SSH port assigned. ` +
            `It was created before SSH support was added. ` +
            `Recreate it with 'avm create' to get an SSH port.`,
        );
        process.exit(1);
      }
      console.log(`==> Connecting via SSH...`);
      process.exit(sshToVm(vm.sshPort));
    }

    if (args.attach) {
      console.log(`==> Attaching to ${vmName}...`);
      process.exit(attachToVm(vmName));
    }
  },
});
