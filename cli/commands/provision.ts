import { defineCommand } from "citty";
import { $ } from "zx";
import { existsSync } from "node:fs";
import { BASE_VM_NAME, avmSetupScript, REPO_ROOT } from "../../lib/config.ts";
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
    if (!existsSync(avmSetupScript)) {
      console.error(`Error: ${avmSetupScript} not found.`);
      console.error(
        `See examples/setup.sh in the avm repo for a starting point:`,
      );
      console.error(`  cp ${REPO_ROOT}/examples/setup.sh ${avmSetupScript}`);
      process.exit(1);
    }

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

    if (base) {
      console.log(`==> Deleting existing ${BASE_VM_NAME}...`);
      await $`orb delete -f ${BASE_VM_NAME}`;
    }

    await provisionBaseVm();

    console.log();
    console.log(`Done. Base VM '${BASE_VM_NAME}' is provisioned and stopped.`);
    console.log(`Start an agent session: avm create --attach`);
  },
});
