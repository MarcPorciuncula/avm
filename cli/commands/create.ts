import { defineCommand } from "citty";
import { $ } from "zx";
import { spawnSync } from "node:child_process";
import { BASE_VM_NAME } from "../../lib/config.ts";
import { loadAvmConfig } from "../../lib/config-file.ts";
import {
  applyLockdown,
  applySessionMounts,
  ensureHostScaffolding,
} from "../../lib/session.ts";
import {
  generateSessionName,
  listAvmVms,
  normalizeVmName,
  waitForSsh,
} from "../../lib/vm.ts";

export const createCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create and start a new agent VM.",
  },
  args: {
    name: {
      type: "positional",
      required: false,
      description:
        "Suffix for the VM name (avm- is prepended automatically). Random if omitted.",
    },
    attach: {
      type: "boolean",
      description: "After setup, exec into the VM via SSH.",
    },
  },
  async run({ args }) {
    const vmName = args.name
      ? normalizeVmName(args.name)
      : generateSessionName();

    const existing = await listAvmVms();
    if (existing.some((v) => v.name === vmName)) {
      console.error(
        `Error: VM ${vmName} already exists. ` +
          `Use 'avm start ${vmName.slice(4)}' to resume it, or ` +
          `'avm clean ${vmName.slice(4)}' to delete and recreate.`,
      );
      process.exit(1);
    }

    // Make sure host scaffolding (~/.avm/system/*, ~/.avm/mirrors, etc.)
    // exists before we try to bind-mount it into the VM.
    ensureHostScaffolding();

    const config = loadAvmConfig();

    console.log(`==> Cloning ${BASE_VM_NAME} -> ${vmName}...`);
    await $`orb clone ${BASE_VM_NAME} ${vmName}`;
    await $`orb start ${vmName}`;
    console.log("==> Waiting for SSH...");
    await waitForSsh(vmName);

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
