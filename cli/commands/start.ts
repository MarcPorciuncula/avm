import { defineCommand } from "citty";
import { $ } from "zx";
import { loadAvmConfig } from "../../lib/config-file.ts";
import { applyPostCreationSetup } from "../../lib/session.ts";
import {
  attachToVm,
  listAvmVms,
  resolveVmByPrefix,
  shortIdOf,
} from "../../lib/vm.ts";

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description: "Resume a stopped agent VM.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Short ID (or unique prefix) of the VM to resume.",
    },
    attach: {
      type: "boolean",
      description: "After setup, exec into the VM via SSH.",
    },
  },
  async run({ args }) {
    if (!args.id) {
      console.error(
        "Error: avm start requires a VM id. Use 'avm create' to start a new session.",
      );
      process.exit(1);
    }

    const vms = await listAvmVms();

    let vmName: string;
    let vmStatus: string;
    try {
      const { vm } = resolveVmByPrefix(args.id, vms);
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
        `Error: VM ${vmName} is already running. Use 'avm attach ${shortIdOf(vmName)}' to connect.`,
      );
      process.exit(1);
    }

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

    console.log();
    console.log("Session ready.");
    console.log();
    console.log(`  Attach: avm attach ${shortIdOf(vmName)}`);
    console.log();

    if (args.attach) {
      console.log(`==> Attaching to ${vmName}...`);
      process.exit(attachToVm(vmName));
    }
  },
});
