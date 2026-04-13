import { defineCommand } from "citty";
import {
  ensureSshd,
  listAvmVms,
  resolveVmByPrefix,
  sshToVm,
} from "../../lib/vm.ts";

export const sshCommand = defineCommand({
  meta: {
    name: "ssh",
    description: "Connect to an agent container over SSH.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Short ID of the container.",
    },
    "print-command": {
      type: "boolean",
      default: false,
      description: "Print the SSH command instead of connecting.",
    },
    "print-config": {
      type: "boolean",
      default: false,
      description: "Print an SSH config block instead of connecting.",
    },
  },
  async run({ args }) {
    const vms = await listAvmVms();
    let vm;
    try {
      vm = resolveVmByPrefix(args.id, vms).vm;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }

    if (!vm.sshPort) {
      console.error(
        `Error: Container ${vm.name} has no SSH port assigned. ` +
          `It was created before SSH support was added. ` +
          `Recreate it with 'avm create' to get an SSH port.`,
      );
      process.exit(1);
    }

    if (vm.status !== "running") {
      console.error(
        `Error: Container ${vm.name} is not running. Start it first with 'avm start ${vm.id}'.`,
      );
      process.exit(1);
    }

    if (args["print-command"]) {
      console.log(`ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p ${vm.sshPort} agent@localhost`);
      return;
    }

    if (args["print-config"]) {
      console.log(`Host ${vm.name}`);
      console.log(`  HostName localhost`);
      console.log(`  Port ${vm.sshPort}`);
      console.log(`  User agent`);
      console.log(`  StrictHostKeyChecking no`);
      console.log(`  UserKnownHostsFile /dev/null`);
      return;
    }

    await ensureSshd(vm.name, vm.sshPort);
    process.exit(sshToVm(vm.sshPort));
  },
});
