import { defineCommand } from "citty";
import { $ } from "zx";
import { listAvmVms, normalizeVmName } from "../../lib/vm.ts";

export const cleanCommand = defineCommand({
  meta: {
    name: "clean",
    description: "Stop and delete one or more agent VMs.",
  },
  args: {
    all: {
      type: "boolean",
      description: "Clean every VM matching `avm-*`.",
    },
  },
  async run({ args }) {
    // Positional arguments come through on `_`.
    const rawIds = ((args as { _?: string[] })._ ?? []).filter(
      (s) => s.length > 0,
    );

    let targets: string[];
    if (args.all) {
      const vms = await listAvmVms();
      targets = vms.map((v) => v.name);
      if (targets.length === 0) {
        console.log("No agent VMs to clean.");
        return;
      }
    } else {
      if (rawIds.length === 0) {
        console.error(
          "Error: provide one or more IDs or use --all.\nUsage: avm clean <id...> | --all",
        );
        process.exit(1);
      }
      targets = rawIds.map((id) => normalizeVmName(id));
    }

    const existing = new Set((await listAvmVms()).map((v) => v.name));

    for (const name of targets) {
      if (!existing.has(name)) {
        console.warn(`!! ${name} does not exist, skipping`);
        continue;
      }
      console.log(`==> Stopping ${name}...`);
      await $`orb stop ${name}`.nothrow();
      console.log(`==> Deleting ${name}...`);
      await $`orb delete -f ${name}`;
    }
  },
});
