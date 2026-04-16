import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseDocument } from "yaml";
import { connectNodeAdapter } from "@connectrpc/connect-node";

import { ensureHostSecret, extractBearerToken, verifyHostSecret, verifyContainerToken } from "./auth.js";
import { StateStore } from "./state.js";
import { ServiceRegistry, type ServiceConfig } from "./registry.js";
import { createRoutes } from "./server.js";

const AVM_HOME = join(homedir(), ".avm");
const DAEMON_DIR = join(AVM_HOME, "daemon");
const SECRET_PATH = join(DAEMON_DIR, "host.secret");
const STATE_PATH = join(DAEMON_DIR, "state.json");
const PID_PATH = join(DAEMON_DIR, "daemon.pid");
const CONFIG_PATH = join(AVM_HOME, "config.yaml");
const DEFAULT_PORT = 6970;

/** Lightweight parse of ~/.avm/config.yaml to extract service definitions. */
function loadConfig(): Record<string, ServiceConfig> {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const doc = parseDocument(raw);
    const parsed = doc.toJS() as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return {};

    const services = parsed.services as Record<string, unknown> | undefined;
    if (!services || typeof services !== "object") return {};

    const result: Record<string, ServiceConfig> = {};
    for (const [name, value] of Object.entries(services)) {
      if (!value || typeof value !== "object") continue;
      const svc = value as Record<string, unknown>;
      const kind = svc.kind as string;
      if (kind !== "process" && kind !== "docker") continue;

      const check = svc.check as Record<string, unknown> | undefined;
      if (!check || typeof check.tcp !== "string") continue;

      result[name] = {
        kind,
        command: Array.isArray(svc.command) ? svc.command.map(String) : undefined,
        container: typeof svc.container === "string" ? svc.container : undefined,
        check: { tcp: check.tcp },
      };
    }
    return result;
  } catch {
    return {};
  }
}

/** Read daemon.port from config.yaml, defaulting to 6970. */
function loadPort(): number {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const doc = parseDocument(raw);
    const parsed = doc.toJS() as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_PORT;

    const daemon = parsed.daemon as Record<string, unknown> | undefined;
    if (!daemon || typeof daemon !== "object") return DEFAULT_PORT;

    const port = daemon.port;
    if (typeof port === "number" && Number.isFinite(port)) return port;
    return DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function main() {
  // 1. Set up daemon directory.
  mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 });

  // 2. Ensure host secret exists.
  const hostSecret = ensureHostSecret(SECRET_PATH);

  // 3. Create state store.
  const stateStore = new StateStore(STATE_PATH);

  // 4. Create service registry.
  const registry = new ServiceRegistry(stateStore);

  // 5. Read port from config.
  const port = loadPort();

  // 6. Create the Connect handler with auth middleware.
  const connectHandler = connectNodeAdapter({ routes: createRoutes(registry, stateStore, loadConfig) });

  const handler: typeof connectHandler = (req, res) => {
    const url = req.url ?? "";

    // Determine which auth to apply based on URL path.
    if (url.startsWith("/avm.host.v1.")) {
      const token = extractBearerToken(req.headers.authorization);
      if (!token || !verifyHostSecret(token, hostSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "unauthenticated", message: "invalid or missing host secret" }));
        return;
      }
    } else if (url.startsWith("/avm.bridge.v1.")) {
      const token = extractBearerToken(req.headers.authorization);
      const containerName = token ? verifyContainerToken(token, stateStore) : null;
      if (!containerName) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "unauthenticated", message: "invalid or missing container token" }));
        return;
      }
      req.headers["x-avm-container-name"] = containerName;
    }

    return connectHandler(req, res);
  };

  // 7. Start HTTP server.
  const server = createServer(handler);

  server.listen(port, "127.0.0.1", () => {
    console.log(`avm-daemon listening on 127.0.0.1:${port}`);

    // 8. Write PID file.
    writeFileSync(PID_PATH, String(process.pid) + "\n", { mode: 0o600 });
  });

  // 9. Handle graceful shutdown.
  const shutdown = () => {
    console.log("avm-daemon shutting down");
    try {
      unlinkSync(PID_PATH);
    } catch {
      // PID file may already be gone.
    }
    server.close(() => {
      console.log("avm-daemon stopped");
      process.exit(0);
    });
    // Force exit if server doesn't close within 5s.
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
