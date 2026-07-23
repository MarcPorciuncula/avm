import { ConnectError } from "@connectrpc/connect";
import { defineCommand } from "citty";
import { createBridgePortForwardClient } from "@avm/shared/bridge-client";

function getClient() {
  const host = process.env.AVM_HOST ?? "127.0.0.1";
  const port = process.env.AVM_HOST_PORT;
  const token = process.env.AVM_HOST_TOKEN;

  if (!port || !token) {
    console.error("This command must run inside an avm container.");
    process.exit(1);
  }
  return createBridgePortForwardClient(host, Number(port), token);
}

function parsePort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return port;
}

function errorMessage(err: unknown): string {
  return err instanceof ConnectError || err instanceof Error ? err.message : String(err);
}

const forwardCommand = defineCommand({
  meta: {
    name: "forward",
    description: "Expose a container port on the host's localhost.",
  },
  args: {
    port: {
      type: "positional",
      description: "Container port",
      required: true,
    },
    "host-port": {
      type: "string",
      description: "Specific host localhost port (defaults to the container port when available)",
    },
  },
  async run({ args }) {
    try {
      const containerPort = parsePort(args.port, "container port");
      const hostPort = args["host-port"]
        ? parsePort(args["host-port"], "host port")
        : 0;
      const forward = await getClient().forwardPort({ containerPort, hostPort });
      console.log(`Forwarding host localhost:${forward.hostPort} -> container :${forward.containerPort}`);
      console.log(`Open: ${forward.url}`);
    } catch (err) {
      console.error(`Error: ${errorMessage(err)}`);
      process.exitCode = 1;
    }
  },
});

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List this container's localhost forwards.",
  },
  async run() {
    try {
      const response = await getClient().listPortForwards({});
      if (response.forwards.length === 0) {
        console.log("No localhost forwards.");
        return;
      }
      console.log("CONTAINER  HOST LOCALHOST  STATUS  URL");
      for (const forward of response.forwards) {
        const status = forward.active ? "ACTIVE" : "ERROR";
        console.log(
          `${String(forward.containerPort).padEnd(11)}` +
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
    description: "Stop forwarding a container port.",
  },
  args: {
    port: {
      type: "positional",
      description: "Container port",
      required: true,
    },
  },
  async run({ args }) {
    try {
      const containerPort = parsePort(args.port, "container port");
      await getClient().stopPortForward({ containerPort });
      console.log(`Stopped localhost forward for container port ${containerPort}.`);
    } catch (err) {
      console.error(`Error: ${errorMessage(err)}`);
      process.exitCode = 1;
    }
  },
});

export const portCommand = defineCommand({
  meta: {
    name: "port",
    description: "Manage host localhost forwards.",
  },
  subCommands: {
    forward: forwardCommand,
    list: listCommand,
    ls: listCommand,
    stop: stopCommand,
  },
});
