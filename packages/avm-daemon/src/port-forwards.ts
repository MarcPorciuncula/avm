import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  portForwardKey,
  type PortForwardState,
  type StateStore,
} from "./state.js";

export interface PortForwardStatus extends PortForwardState {
  active: boolean;
  lastError: string;
}

export class PortForwardError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "not-found" | "in-use",
  ) {
    super(message);
  }
}

interface RuntimeForward {
  state: PortForwardState;
  server: Server | null;
  lastError: string;
}

const serverConnections = new WeakMap<Server, Set<Socket>>();

export class PortForwardManager {
  private readonly forwards = new Map<string, RuntimeForward>();
  private readonly reservedHostPorts: Set<number>;

  constructor(
    private readonly stateStore: StateStore,
    reservedHostPorts: Iterable<number> = [],
  ) {
    this.reservedHostPorts = new Set(reservedHostPorts);
  }

  /** Restore persisted listeners after a daemon restart. */
  async restore(): Promise<void> {
    for (const state of this.stateStore.listPortForwards()) {
      try {
        const server = await this.listen(state, state.hostPort);
        this.forwards.set(portForwardKey(state.containerName, state.containerPort), {
          state,
          server,
          lastError: "",
        });
      } catch (err) {
        this.forwards.set(portForwardKey(state.containerName, state.containerPort), {
          state,
          server: null,
          lastError: errorMessage(err),
        });
      }
    }
  }

  async forward(
    containerName: string,
    containerPort: number,
    requestedHostPort: number,
  ): Promise<PortForwardStatus> {
    validatePort(containerPort, "container");
    if (requestedHostPort !== 0) validateHostPort(requestedHostPort);

    const key = portForwardKey(containerName, containerPort);
    const existing = this.forwards.get(key);
    if (existing && (requestedHostPort === 0 || requestedHostPort === existing.state.hostPort)) {
      if (!existing.server) {
        existing.server = await this.listen(existing.state, existing.state.hostPort);
        existing.lastError = "";
      }
      return toStatus(existing);
    }

    const samePortAvailable =
      containerPort >= 1024 && !this.reservedHostPorts.has(containerPort);
    const preferredPort = requestedHostPort || (samePortAvailable ? containerPort : 0);
    let state: PortForwardState = {
      containerName,
      containerPort,
      hostPort: preferredPort,
      createdAt: new Date().toISOString(),
    };

    let server: Server;
    try {
      server = await this.listen(state, preferredPort);
    } catch (err) {
      if (requestedHostPort !== 0 || !isAddressInUse(err)) throw err;
      server = await this.listen(state, 0);
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("localhost forward did not receive a TCP port");
    }
    state = { ...state, hostPort: address.port };

    if (existing?.server) await closeServer(existing.server);
    const runtime = { state, server, lastError: "" };
    this.forwards.set(key, runtime);
    this.stateStore.setPortForward(state);
    return toStatus(runtime);
  }

  list(containerName?: string): PortForwardStatus[] {
    return [...this.forwards.values()]
      .filter((forward) => !containerName || forward.state.containerName === containerName)
      .map(toStatus)
      .sort((a, b) =>
        a.containerName.localeCompare(b.containerName) || a.containerPort - b.containerPort,
      );
  }

  async stop(containerName: string, containerPort: number): Promise<void> {
    const key = portForwardKey(containerName, containerPort);
    const forward = this.forwards.get(key);
    if (!forward) {
      throw new PortForwardError(
        `no localhost forward for ${containerName}:${containerPort}`,
        "not-found",
      );
    }
    if (forward.server) await closeServer(forward.server);
    this.forwards.delete(key);
    this.stateStore.clearPortForward(containerName, containerPort);
  }

  async removeContainer(containerName: string): Promise<void> {
    const owned = [...this.forwards.values()].filter(
      (forward) => forward.state.containerName === containerName,
    );
    await Promise.all(
      owned.map((forward) => forward.server ? closeServer(forward.server) : Promise.resolve()),
    );
    for (const forward of owned) {
      this.forwards.delete(portForwardKey(containerName, forward.state.containerPort));
    }
    this.stateStore.clearContainerPortForwards(containerName);
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.forwards.values()].map((forward) =>
        forward.server ? closeServer(forward.server) : Promise.resolve(),
      ),
    );
  }

  private listen(state: PortForwardState, hostPort: number): Promise<Server> {
    if (hostPort !== 0 && this.reservedHostPorts.has(hostPort)) {
      throw new PortForwardError(
        `localhost:${hostPort} is reserved by the avm daemon`,
        "in-use",
      );
    }
    return new Promise((resolve, reject) => {
      const server = createServer((client) => {
        const upstream = createConnection({
          host: `${state.containerName}.orb.local`,
          port: state.containerPort,
        });
        const connections = serverConnections.get(server)!;
        connections.add(client);
        connections.add(upstream);
        client.once("close", () => connections.delete(client));
        upstream.once("close", () => connections.delete(upstream));
        client.pipe(upstream);
        upstream.pipe(client);
        const close = () => {
          client.destroy();
          upstream.destroy();
        };
        client.once("error", close);
        upstream.once("error", close);
      });
      serverConnections.set(server, new Set());
      server.once("error", (err) => {
        if (isAddressInUse(err)) {
          reject(
            new PortForwardError(
              `localhost:${hostPort} is already in use`,
              "in-use",
            ),
          );
        } else {
          reject(err);
        }
      });
      server.listen(hostPort, "127.0.0.1", () => resolve(server));
    });
  }
}

function validatePort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PortForwardError(`${label} port must be between 1 and 65535`, "invalid");
  }
}

function validateHostPort(port: number): void {
  validatePort(port, "host");
  if (port < 1024) {
    throw new PortForwardError("host port must be 1024 or greater", "invalid");
  }
}

function isAddressInUse(err: unknown): boolean {
  return err instanceof PortForwardError
    ? err.kind === "in-use"
    : (err as NodeJS.ErrnoException)?.code === "EADDRINUSE";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toStatus(forward: RuntimeForward): PortForwardStatus {
  return {
    ...forward.state,
    active: forward.server?.listening ?? false,
    lastError: forward.lastError,
  };
}

function closeServer(server: Server): Promise<void> {
  for (const connection of serverConnections.get(server) ?? []) {
    connection.destroy();
  }
  serverConnections.delete(server);
  return new Promise((resolve) => server.close(() => resolve()));
}
