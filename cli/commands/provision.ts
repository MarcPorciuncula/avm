import { defineCommand } from "citty";
import { $ } from "zx";
import { BASE_VM_NAME, LEGACY_BASE_VM_NAME } from "../../lib/config.ts";
import { provisionBaseVm } from "../../lib/base-vm.ts";

interface OrbListEntry {
  name: string;
  state: string;
}

export const provisionCommand = defineCommand({
  meta: {
    name: "provision",
    description:
      "Create or rebuild the base VM template that agent sessions clone from.",
  },
  async run() {
    const result = await $`orb list -f json`.quiet();
    const entries = JSON.parse(result.stdout) as OrbListEntry[];

    const base = entries.find((e) => e.name === BASE_VM_NAME);
    if (base && base.state === "running") {
      console.error(
        `Error: ${BASE_VM_NAME} is running. Stop it first:\n` +
          `  orb stop ${BASE_VM_NAME}`,
      );
      process.exit(1);
    }

    // Migration: if a legacy base VM from before the rename still exists,
    // remove it so it doesn't clutter `orb list` or confuse new users.
    const legacy = entries.find((e) => e.name === LEGACY_BASE_VM_NAME);
    if (legacy) {
      console.log(`==> Removing legacy ${LEGACY_BASE_VM_NAME} VM...`);
      await $`orb stop ${LEGACY_BASE_VM_NAME}`.nothrow();
      await $`orb delete -f ${LEGACY_BASE_VM_NAME}`;
    }

    if (base) {
      console.log(`==> Deleting existing ${BASE_VM_NAME}...`);
      await $`orb delete -f ${BASE_VM_NAME}`;
    }

    await provisionBaseVm();

    console.log();
    console.log(`Done. Base VM '${BASE_VM_NAME}' is provisioned and stopped.`);
    console.log(`Start an agent session: avm start --clone --attach`);
  },
});
