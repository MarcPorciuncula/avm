import { defineCommand } from "citty";
import { $ } from "zx";
import { spawnSync } from "node:child_process";
import { loadAvmConfig } from "../../lib/config-file.ts";
import { applyLockdown, applySessionMounts } from "../../lib/session.ts";
import {
  listAvmVms,
  resolveVmByPrefix,
  shortIdOf,
  waitForSsh,
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
    await $`orb start ${vmName}`;
    console.log("==> Waiting for SSH...");
    await waitForSsh(vmName);

    // Bind mounts don't persist across orb stop, so every resume has to
    // redo them. This also regenerates /usr/local/bin/avm-link, so
    // config.yaml changes take effect on resume.
    await applySessionMounts(vmName, config);
    await applyLockdown(vmName);

    console.log();
    console.log("Session ready.");
    console.log();
    console.log(`  SSH: ssh ${vmName}@orb`);
    console.log();

    if (args.attach) {
      console.log(`==> Attaching to ${vmName}...`);
      const result = spawnSync("ssh", ["-t", `${vmName}@orb`], {
        stdio: "inherit",
      });
      process.exit(result.status ?? 0);
    }
  },
});
