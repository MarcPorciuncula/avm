import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { select, isCancel, cancel } from "@clack/prompts";
import { listAvmVms, normalizeVmName } from "../../lib/vm.ts";

export const attachCommand = defineCommand({
  meta: {
    name: "attach",
    description:
      "SSH into an agent VM. If no ID is given, pick one interactively.",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description: "Short ID of the VM to attach to.",
    },
  },
  async run({ args }) {
    let vmName: string;

    if (args.id) {
      vmName = normalizeVmName(args.id);
    } else {
      const vms = await listAvmVms();
      if (vms.length === 0) {
        console.log("No agent VMs. Run `avm start` first.");
        return;
      }
      const picked = await select({
        message: "Select a VM to attach to",
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

    const result = spawnSync("ssh", ["-t", `${vmName}@orb`], {
      stdio: "inherit",
    });
    process.exit(result.status ?? 0);
  },
});
