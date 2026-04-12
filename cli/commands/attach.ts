import { defineCommand } from "citty";
import { select, isCancel, cancel } from "@clack/prompts";
import { attachToVm, listAvmVms, resolveVmByPrefix } from "../../lib/vm.ts";

export const attachCommand = defineCommand({
  meta: {
    name: "attach",
    description:
      "Attach to an agent container. If no ID is given, pick one interactively.",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description: "Short ID of the container to attach to.",
    },
  },
  async run({ args }) {
    const vms = await listAvmVms();
    let vmName: string;

    if (args.id) {
      try {
        vmName = resolveVmByPrefix(args.id, vms).vm.name;
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      if (vms.length === 0) {
        console.log("No agent containers. Run `avm create` first.");
        return;
      }
      const picked = await select({
        message: "Select a container to attach to",
        options: vms.map((vm) => ({
          value: vm.name,
          label: `${vm.id} (${vm.status})`,
        })),
      });
      if (isCancel(picked)) {
        cancel("Aborted.");
        process.exit(0);
      }
      vmName = picked as string;
    }

    process.exit(attachToVm(vmName));
  },
});
