import { defineCommand } from "citty";
import { $ } from "zx";
import { confirm, isCancel, cancel } from "@clack/prompts";
import { listAvmVms, resolveVmByPrefix } from "../../lib/vm.ts";

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
    const rawIds = ((args as { _?: string[] })._ ?? []).filter(
      (s) => s.length > 0,
    );
    const vms = await listAvmVms();

    interface Target {
      name: string;
      /** True when resolved from a prefix (requires confirmation). */
      isPartial: boolean;
    }

    let targets: Target[];
    if (args.all) {
      targets = vms.map((v) => ({ name: v.name, isPartial: false }));
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
      targets = [];
      for (const id of rawIds) {
        try {
          const { vm, isPartial } = resolveVmByPrefix(id, vms);
          targets.push({ name: vm.name, isPartial });
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      }
    }

    for (const target of targets) {
      if (target.isPartial) {
        const ok = await confirm({
          message: `Delete ${target.name}?`,
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          cancel(`Skipped ${target.name}.`);
          continue;
        }
      }
      console.log(`==> Stopping ${target.name}...`);
      await $`docker stop ${target.name}`.nothrow();
      console.log(`==> Deleting ${target.name}...`);
      await $`docker rm -f ${target.name}`;
    }
  },
});
