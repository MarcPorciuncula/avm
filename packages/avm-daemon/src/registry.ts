import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { $ } from "zx";
import type { StateStore } from "./state.js";

export interface ServiceConfig {
  kind: "process" | "docker";
  command?: string[];
  container?: string;
  check: { tcp: string };
}

export interface ServiceStatus {
  name: string;
  kind: "process" | "docker";
  state: "up" | "down" | "starting" | "stopping" | "unknown";
  pid: number;
  lastError: string;
  lastCheckAt: Date;
}

/**
 * Check if a TCP endpoint is accepting connections.
 * Resolves true on successful connect, false on error or timeout (1s).
 */
function checkHealth(tcpAddr: string): Promise<boolean> {
  return new Promise((resolve) => {
    const [host, portStr] = tcpAddr.split(":");
    const port = parseInt(portStr, 10);

    const socket = createConnection({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });

    socket.setTimeout(1000);
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Check whether a PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll a predicate every `intervalMs` for up to `timeoutMs`. */
async function pollUntil(
  predicate: () => Promise<boolean>,
  intervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function makeStatus(
  name: string,
  kind: ServiceConfig["kind"],
  state: ServiceStatus["state"],
  pid: number,
  lastError: string,
): ServiceStatus {
  return { name, kind, state, pid, lastError, lastCheckAt: new Date() };
}

export class ServiceRegistry {
  constructor(private readonly stateStore: StateStore) {}

  /** Run the health check and return current status. */
  async getStatus(name: string, config: ServiceConfig): Promise<ServiceStatus> {
    const healthy = await checkHealth(config.check.tcp);
    const pid = this.stateStore.getServicePid(name) ?? 0;
    const state = healthy ? "up" : "down";
    return makeStatus(name, config.kind, state, pid, "");
  }

  /**
   * Idempotent start. If already healthy, return current status.
   * Otherwise start the service and poll until healthy or timeout.
   */
  async start(name: string, config: ServiceConfig): Promise<ServiceStatus> {
    // Already up — no-op.
    const healthy = await checkHealth(config.check.tcp);
    if (healthy) {
      const pid = this.stateStore.getServicePid(name) ?? 0;
      return makeStatus(name, config.kind, "up", pid, "");
    }

    // Start the service.
    if (config.kind === "process") {
      if (!config.command || config.command.length === 0) {
        return makeStatus(name, config.kind, "down", 0, "no command specified");
      }
      const [bin, ...args] = config.command;
      const child = spawn(bin, args, { detached: true, stdio: "ignore" });
      child.unref();
      const pid = child.pid ?? 0;
      if (pid > 0) {
        this.stateStore.setServicePid(name, pid);
      }
    } else {
      // kind: docker
      if (!config.container) {
        return makeStatus(
          name,
          config.kind,
          "down",
          0,
          "no container specified",
        );
      }
      try {
        await $`docker start ${config.container}`;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return makeStatus(name, config.kind, "down", 0, msg);
      }
    }

    // Poll health check every 250ms for up to 10s.
    const came_up = await pollUntil(
      () => checkHealth(config.check.tcp),
      250,
      10_000,
    );

    const pid = this.stateStore.getServicePid(name) ?? 0;
    if (came_up) {
      return makeStatus(name, config.kind, "up", pid, "");
    }
    return makeStatus(
      name,
      config.kind,
      "down",
      pid,
      "timed out waiting for health check",
    );
  }

  /**
   * Idempotent stop. If already down, return current status.
   * Otherwise stop the service gracefully (SIGTERM, then SIGKILL).
   */
  async stop(name: string, config: ServiceConfig): Promise<ServiceStatus> {
    // Already down — no-op.
    const healthy = await checkHealth(config.check.tcp);
    if (!healthy) {
      return makeStatus(name, config.kind, "down", 0, "");
    }

    if (config.kind === "process") {
      const pid = this.stateStore.getServicePid(name);
      if (pid && isProcessAlive(pid)) {
        // SIGTERM first.
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already dead — fine.
        }

        // Poll every 250ms for up to 5s.
        const stopped = await pollUntil(
          async () => !isProcessAlive(pid),
          250,
          5_000,
        );

        // SIGKILL if still alive.
        if (!stopped) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already dead.
          }
        }
      }
      this.stateStore.clearServicePid(name);
    } else {
      // kind: docker
      if (!config.container) {
        return makeStatus(
          name,
          config.kind,
          "down",
          0,
          "no container specified",
        );
      }
      try {
        await $`docker stop ${config.container}`;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return makeStatus(name, config.kind, "unknown", 0, msg);
      }
    }

    return makeStatus(name, config.kind, "down", 0, "");
  }
}
