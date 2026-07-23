import { ConnectError } from "@connectrpc/connect";
import { defineCommand } from "citty";
import { createHostPortForwardClient } from "@avm/shared/host-client";
import { ensureDaemonRunning } from "../../lib/daemon.ts";
import { listAvmVms, resolveVmArg } from "../../lib/vm.ts";

async function getClient() {
  const { port, secret } = await ensureDaemonRunning();
  return createHostPortForwardClient(port, secret);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("container port must be between 1 and 65535");
  }
  return port;
}

function errorMessage(err: unknown): string {
  return err instanceof ConnectError || err instanceof Error ? err.message : String(err);
}

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List localhost forwards for all avm containers.",
  },
  async run() {
    try {
      const response = await (await getClient()).listPortForwards({});
      if (response.forwards.length === 0) {
        console.log("No localhost forwards.");
        return;
      }
      const containerWidth = Math.max(
        "CONTAINER".length,
        ...response.forwards.map((forward) => forward.containerName.length),
      );
      console.log(`${"CONTAINER".padEnd(containerWidth + 2)}PORT  HOST LOCALHOST  STATUS  URL`);
      for (const forward of response.forwards) {
        const status = forward.active ? "ACTIVE" : "ERROR";
        console.log(
          `${forward.containerName.padEnd(containerWidth + 2)}` +
          `${String(forward.containerPort).padEnd(6)}` +
          `${String(forward.hostPort).padEnd(16)}` +
          `${status.padEnd(8)}` +
          forward.url,
        );
        if (forward.lastError) console.log(`  ${forward.lastError}`);
      }
    } catch (err) {
      console.error(`Error: ${errorMessage(err)}`);
      process.exitCode = 1;
    }
  },
});

const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop a container's localhost forward.",
  },
  args: {
    id: {
      type: "positional",
      description: "Container ID or name",
      required: true,
    },
    port: {
      type: "positional",
      description: "Container port",
      required: true,
    },
  },
  async run({ args }) {
    try {
      const vm = resolveVmArg(args.id, await listAvmVms());
      const containerPort = parsePort(args.port);
      await (await getClient()).stopPortForward({
        containerName: vm.name,
        containerPort,
      });
      console.log(`Stopped localhost forward for ${vm.id}:${containerPort}.`);
    } catch (err) {
      console.error(`Error: ${errorMessage(err)}`);
      process.exitCode = 1;
    }
  },
});

export const portCommand = defineCommand({
  meta: {
    name: "port",
    description: "Inspect and stop localhost forwards.",
  },
  subCommands: {
    list: listCommand,
    ls: listCommand,
    stop: stopCommand,
  },
});
