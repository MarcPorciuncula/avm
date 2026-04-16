import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface DaemonState {
  containers: Record<string, { token: string; createdAt: string }>;
  servicePids: Record<string, number>;
}

function emptyState(): DaemonState {
  return { containers: {}, servicePids: {} };
}

export class StateStore {
  private state: DaemonState;

  constructor(private readonly path: string) {
    this.state = this.read();
  }

  /** Read state from disk. Returns empty state if file missing or corrupt. */
  private read(): DaemonState {
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        containers: parsed.containers ?? {},
        servicePids: parsed.servicePids ?? {},
      };
    } catch {
      return emptyState();
    }
  }

  /** Atomically persist: write temp file, rename over original. */
  private persist(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(tmp, this.path);
  }

  /** Generate a random token, register the container, and return the token. */
  registerContainer(name: string): string {
    const token = randomBytes(32).toString("base64url");
    this.state.containers[name] = {
      token,
      createdAt: new Date().toISOString(),
    };
    this.persist();
    return token;
  }

  /** Remove a container entry. */
  unregisterContainer(name: string): void {
    delete this.state.containers[name];
    this.persist();
  }

  /** Look up which container a token belongs to. Returns null if not found. */
  resolveToken(token: string): string | null {
    for (const [name, entry] of Object.entries(this.state.containers)) {
      if (entry.token === token) return name;
    }
    return null;
  }

  /** Get a tracked service PID. */
  getServicePid(name: string): number | undefined {
    return this.state.servicePids[name];
  }

  /** Store a service PID. */
  setServicePid(name: string, pid: number): void {
    this.state.servicePids[name] = pid;
    this.persist();
  }

  /** Remove a tracked service PID. */
  clearServicePid(name: string): void {
    delete this.state.servicePids[name];
    this.persist();
  }
}
