import { defineCommand } from "citty";
import { loadAvmConfig } from "../../lib/config-file.ts";
import {
  isDaemonReachable,
  isProcessAlive,
  readDaemonPid,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from "../../lib/daemon.ts";

const startCommand = defineCommand({
  meta: {
    name: "start",
    description: "Start the avm daemon in the background.",
  },
  async run() {
    try {
      const result = await startDaemon();
      console.log(result === "started" ? "Daemon started." : "Daemon already running.");
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop the avm daemon.",
  },
  async run() {
    try {
      const result = await stopDaemon();
      console.log(result === "stopped" ? "Stopped." : "Daemon is not running.");
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const restartCommand = defineCommand({
  meta: {
    name: "restart",
    description: "Restart the avm daemon.",
  },
  async run() {
    try {
      await restartDaemon();
      console.log("Daemon restarted.");
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  },
});

const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show daemon status.",
  },
  async run() {
    const config = loadAvmConfig();
    const port = config.daemon.port;
    const url = `http://127.0.0.1:${port}`;

    const pid = readDaemonPid();
    const alive = pid !== null && isProcessAlive(pid);
    const reachable = await isDaemonReachable(port);

    console.log(`URL:        ${url}`);
    console.log(`PID:        ${pid !== null && alive ? pid : "(not running)"}`);
    console.log(`Reachable:  ${reachable ? "yes" : "no"}`);
  },
});

export const daemonCommand = defineCommand({
  meta: {
    name: "daemon",
    description: "Manage the avm daemon.",
  },
  subCommands: {
    start: startCommand,
    stop: stopCommand,
    restart: restartCommand,
    status: statusCommand,
  },
});
