import { defineCommand } from "citty";
import { $ } from "zx";
import { loadAvmConfig } from "../../lib/config-file.ts";
import {
  applyLockdown,
  applySessionMounts,
  ensureHostScaffolding,
} from "../../lib/session.ts";
import {
  attachToVm,
  generateSessionName,
  listAvmVms,
  normalizeVmName,
  shortIdOf,
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
          `Use 'avm start ${shortIdOf(vmName)}' to resume it, or ` +
          `'avm clean ${shortIdOf(vmName)}' to delete and recreate.`,
      );
      process.exit(1);
    }

    // Make sure host scaffolding (~/.avm/system/*, ~/.avm/mirrors, etc.)
    // exists before we try to bind-mount it into the VM.
    ensureHostScaffolding();

    let config;
    try {
      config = loadAvmConfig();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }

    // TODO(docker-port): replace with docker run from USER_IMAGE
    console.log(`==> Creating container ${vmName}...`);
    await $`docker run -d --name ${vmName} --label avm=true avm sleep infinity`;

    await applySessionMounts(vmName, config);
    await applyLockdown(vmName);

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
