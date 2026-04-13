import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { listAvmVms, resolveVmByPrefix } from "../../lib/vm.ts";

export const execCommand = defineCommand({
  meta: {
    name: "exec",
    description: "Run a command inside an agent container.",
  },
  args: {
    root: {
      type: "boolean",
      default: false,
      description: "Run as root instead of agent.",
    },
    id: {
      type: "positional",
      required: true,
      description: "Short ID of the container.",
    },
  },
  async run({ args }) {
    const vms = await listAvmVms();
    let vmName: string;
    try {
      vmName = resolveVmByPrefix(args.id, vms).vm.name;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }

    // Everything after the positional id is the command to run.
    // citty consumes known args; the rest land in process.argv after `--` or
    // after the positional. We find the id in argv and take everything after it.
    const rawArgs = process.argv;
    const idIndex = rawArgs.indexOf(args.id);
    const cmdArgs = idIndex !== -1 ? rawArgs.slice(idIndex + 1) : [];

    if (cmdArgs.length === 0) {
      console.error("Error: no command specified. Usage: avm exec <id> <cmd...>");
      process.exit(1);
    }

    const user = args.root ? "root" : "agent";
    const result = spawnSync(
      "docker",
      ["exec", "-i", "-u", user, vmName, ...cmdArgs],
      { stdio: "inherit" },
    );
    process.exit(result.status ?? 1);
  },
});
