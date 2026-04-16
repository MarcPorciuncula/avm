import { defineCommand } from "citty";
import {
  createBridgeClient,
  Kind,
  State,
} from "@avm/shared/bridge-client";

function getClient() {
  const port = process.env.AVM_HOST_PORT;
  const token = process.env.AVM_HOST_TOKEN;

  if (!port) {
    console.error("AVM_HOST_PORT is not set. This command must run inside an avm container.");
    process.exit(1);
  }
  if (!token) {
    console.error("AVM_HOST_TOKEN is not set. This command must run inside an avm container.");
    process.exit(1);
  }

  return createBridgeClient(Number(port), token);
}

function kindLabel(k: Kind): string {
  switch (k) {
    case Kind.PROCESS:
      return "process";
    case Kind.DOCKER:
      return "docker";
    default:
      return "unknown";
  }
}

function stateLabel(s: State): string {
  switch (s) {
    case State.UP:
      return "UP";
    case State.DOWN:
      return "DOWN";
    case State.STARTING:
      return "STARTING";
    case State.STOPPING:
      return "STOPPING";
    default:
      return "UNKNOWN";
  }
}

const lsCommand = defineCommand({
  meta: {
    name: "ls",
    description: "List all declared services.",
  },
  async run() {
    const client = getClient();
    const res = await client.listServices({});

    if (res.services.length === 0) {
      console.log("No services declared.");
      return;
    }

    const nameWidth = Math.max(
      4,
      ...res.services.map((s) => s.name.length),
    );

    console.log("NAME".padEnd(nameWidth + 2) + "STATE");
    for (const svc of res.services) {
      console.log(
        svc.name.padEnd(nameWidth + 2) + stateLabel(svc.state),
      );
    }
  },
});

const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show status for a service.",
  },
  args: {
    name: {
      type: "positional",
      description: "Service name",
      required: true,
    },
  },
  async run({ args }) {
    const client = getClient();
    const svc = await client.getService({ name: args.name });

    console.log(`Name:   ${svc.name}`);
    console.log(`State:  ${stateLabel(svc.state)}`);
    if (svc.lastError) {
      console.log(`Error:  ${svc.lastError}`);
    }
  },
});

const startCommand = defineCommand({
  meta: {
    name: "start",
    description: "Start a service.",
  },
  args: {
    name: {
      type: "positional",
      description: "Service name",
      required: true,
    },
  },
  async run({ args }) {
    const client = getClient();
    const svc = await client.startService({ name: args.name });
    console.log(`${svc.name}: ${stateLabel(svc.state)}`);
  },
});

const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop a service.",
  },
  args: {
    name: {
      type: "positional",
      description: "Service name",
      required: true,
    },
  },
  async run({ args }) {
    const client = getClient();
    const svc = await client.stopService({ name: args.name });
    console.log(`${svc.name}: ${stateLabel(svc.state)}`);
  },
});

export const serviceCommand = defineCommand({
  meta: {
    name: "service",
    description: "Manage host services.",
  },
  subCommands: {
    ls: lsCommand,
    status: statusCommand,
    start: startCommand,
    stop: stopCommand,
  },
});
