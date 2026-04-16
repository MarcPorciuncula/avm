import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadAvmConfig } from "../../lib/config-file.ts";
import {
  avmDaemonDir,
  avmDaemonPidFile,
  avmDaemonLogFile,
} from "../../lib/config.ts";

const distDir = dirname(fileURLToPath(import.meta.url));
const daemonBin = join(distDir, "avm-daemon.mjs");

async function isDaemonReachable(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  try {
    const raw = readFileSync(avmDaemonPidFile, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const startCommand = defineCommand({
  meta: {
    name: "start",
    description: "Start the avm daemon in the background.",
  },
  async run() {
    const config = loadAvmConfig();
    const port = config.daemon.port;

    if (await isDaemonReachable(port)) {
      console.log("Daemon already running.");
      return;
    }

    // Ensure daemon dir exists
    mkdirSync(avmDaemonDir, { recursive: true });

    const logFd = openSync(avmDaemonLogFile, "a");

    const child = spawn(process.execPath, [daemonBin], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    });

    closeSync(logFd);

    child.unref();

    // Write PID file
    if (child.pid) {
      writeFileSync(avmDaemonPidFile, String(child.pid));
    }

    // Poll for reachability
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(200);
      if (await isDaemonReachable(port)) {
        console.log("Daemon started.");
        return;
      }
    }

    console.error(
      "Error: daemon did not become reachable within 5 seconds. Check logs at:",
      avmDaemonLogFile,
    );
    process.exit(1);
  },
});

const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop the avm daemon.",
  },
  async run() {
    const pid = readPid();
    if (pid === null) {
      console.log("Daemon is not running.");
      return;
    }

    if (!isProcessAlive(pid)) {
      console.log("Daemon is not running.");
      try {
        unlinkSync(avmDaemonPidFile);
      } catch {}
      return;
    }

    process.kill(pid, "SIGTERM");
    console.log("Stopped.");

    try {
      unlinkSync(avmDaemonPidFile);
    } catch {}
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

    const pid = readPid();
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
    status: statusCommand,
  },
});
