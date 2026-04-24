import { defineCommand } from "citty";
import { ensureDaemonRunning } from "../../lib/daemon.ts";
import {
  createHostServicesClient,
  Kind,
  State,
} from "@avm/shared/host-client";

async function getClient() {
  try {
    const { port, secret } = await ensureDaemonRunning();
    return createHostServicesClient(port, secret);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
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
    const client = await getClient();
    const res = await client.listServices({});

    if (res.services.length === 0) {
      console.log("No services declared in ~/.avm/config.yaml");
      return;
    }

    // Simple table output
    const nameWidth = Math.max(
      4,
      ...res.services.map((s) => s.name.length),
    );
    const kindWidth = Math.max(4, ...res.services.map((s) => kindLabel(s.kind).length));

    console.log(
      "NAME".padEnd(nameWidth + 2) +
        "KIND".padEnd(kindWidth + 2) +
        "STATE",
    );
    for (const svc of res.services) {
      console.log(
        svc.name.padEnd(nameWidth + 2) +
          kindLabel(svc.kind).padEnd(kindWidth + 2) +
          stateLabel(svc.state),
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
    const client = await getClient();
    const svc = await client.getService({ name: args.name });

    console.log(`Name:   ${svc.name}`);
    console.log(`Kind:   ${kindLabel(svc.kind)}`);
    console.log(`State:  ${stateLabel(svc.state)}`);
    if (svc.pid) {
      console.log(`PID:    ${svc.pid}`);
    }
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
    const client = await getClient();
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
    const client = await getClient();
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
