import { defineCommand } from "citty";
import { $ } from "zx";
import { listAvmVms, resolveVmByPrefix } from "../../lib/vm.ts";

export const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop one or more agent VMs without destroying them.",
  },
  args: {
    all: {
      type: "boolean",
      description: "Stop every running session VM.",
    },
  },
  async run({ args }) {
    const rawIds = ((args as { _?: string[] })._ ?? []).filter(
      (s) => s.length > 0,
    );
    const vms = await listAvmVms();

    let targets: string[];
    if (args.all) {
      targets = vms
        .filter((v) => v.status === "running")
        .map((v) => v.name);
      if (targets.length === 0) {
        console.log("No running agent VMs.");
        return;
      }
    } else {
      if (rawIds.length === 0) {
        console.error(
          "Error: provide one or more IDs or use --all.\nUsage: avm stop <id...> | --all",
        );
        process.exit(1);
      }
      targets = [];
      for (const id of rawIds) {
        try {
          targets.push(resolveVmByPrefix(id, vms).vm.name);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      }
    }

    for (const name of targets) {
      console.log(`==> Stopping ${name}...`);
      await $`orb stop ${name}`.nothrow();
    }
  },
});
