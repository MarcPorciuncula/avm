import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { ensureDaemonRunning } from "../../lib/daemon.ts";
import { listAvmVms, resolveVmArg } from "../../lib/vm.ts";

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
      required: false,
      description: "Short ID of the container.",
    },
  },
  async run({ args }) {
    const vms = await listAvmVms();
    let vmName: string;
    try {
      vmName = resolveVmArg(args.id, vms).name;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }

    // Everything after the positional id is the command to run.
    // citty consumes known args; the rest land in process.argv after `--` or
    // after the positional. When an id was given, find it in argv and slice
    // after it. When no id was given (auto-selected), slice after "exec".
    const rawArgs = process.argv;
    let cmdArgs: string[];
    if (args.id !== undefined) {
      const idIndex = rawArgs.indexOf(args.id);
      cmdArgs = idIndex !== -1 ? rawArgs.slice(idIndex + 1) : [];
    } else {
      const execIndex = rawArgs.lastIndexOf("exec");
      cmdArgs = execIndex !== -1 ? rawArgs.slice(execIndex + 1) : [];
    }

    if (cmdArgs.length === 0) {
      console.error("Error: no command specified. Usage: avm exec <id> <cmd...>");
      process.exit(1);
    }

    try {
      await ensureDaemonRunning();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
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
