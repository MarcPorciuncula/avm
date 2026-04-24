import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadAvmConfig } from "./config-file.ts";
import {
  avmDaemonDir,
  avmDaemonHostSecretFile,
  avmDaemonLogFile,
  avmDaemonPidFile,
} from "./config.ts";

const distDir = dirname(fileURLToPath(import.meta.url));
const daemonBin = join(distDir, "avm-daemon.mjs");

const STARTUP_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isDaemonReachable(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return true;
  } catch {
    return false;
  }
}

export function readDaemonPid(): number | null {
  try {
    const raw = readFileSync(avmDaemonPidFile, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the avm daemon as a detached background process.
 *
 * Returns `"started"` if a new daemon was spawned, `"already-running"`
 * if one was already reachable. Throws if the daemon fails to come up
 * within the startup timeout.
 */
export async function startDaemon(): Promise<"started" | "already-running"> {
  const config = loadAvmConfig();
  const port = config.daemon.port;

  if (await isDaemonReachable(port)) return "already-running";

  mkdirSync(avmDaemonDir, { recursive: true });

  const logFd = openSync(avmDaemonLogFile, "a");
  const child = spawn(process.execPath, [daemonBin], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  closeSync(logFd);
  child.unref();

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (await isDaemonReachable(port)) return "started";
  }

  throw new Error(
    `daemon did not become reachable within ${STARTUP_TIMEOUT_MS / 1000}s on port ${port}. Check logs at ${avmDaemonLogFile}`,
  );
}

/**
 * Stop the avm daemon (SIGTERM) and wait for the process to exit.
 *
 * Returns `"stopped"` if a running daemon was terminated,
 * `"not-running"` if no daemon was running. Throws if the daemon does
 * not exit within the shutdown timeout.
 */
export async function stopDaemon(): Promise<"stopped" | "not-running"> {
  const pid = readDaemonPid();
  if (pid === null || !isProcessAlive(pid)) {
    try {
      unlinkSync(avmDaemonPidFile);
    } catch {}
    return "not-running";
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    try {
      unlinkSync(avmDaemonPidFile);
    } catch {}
    return "not-running";
  }

  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      try {
        unlinkSync(avmDaemonPidFile);
      } catch {}
      return "stopped";
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `daemon (PID ${pid}) did not exit within ${SHUTDOWN_TIMEOUT_MS / 1000}s of SIGTERM`,
  );
}

/**
 * Stop the daemon (if running) and start it again.
 */
export async function restartDaemon(): Promise<void> {
  await stopDaemon();
  await startDaemon();
}

/**
 * Ensure the daemon is running and return its connection details.
 *
 * Auto-starts the daemon if not reachable. Use this from any command
 * that needs the daemon — directly, or because the command leaves a
 * container running that will phone home through avm-bridge.
 */
export async function ensureDaemonRunning(): Promise<{ port: number; secret: string }> {
  const config = loadAvmConfig();
  await startDaemon();
  const secret = readFileSync(avmDaemonHostSecretFile, "utf-8").trim();
  return { port: config.daemon.port, secret };
}
