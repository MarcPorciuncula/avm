# Host Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable avm agents inside containers to start, stop, and check host-side services (Chrome, Postgres, etc.) via a daemon + bridge CLI over Connect RPC, with per-container auth.

**Architecture:** Four pnpm workspace packages: `avm` (host CLI), `avm-daemon` (Connect server owning all state), `avm-bridge` (in-container CLI), `shared` (proto types + client factories). Two proto packages (`avm.bridge.v1`, `avm.host.v1`) with separate auth domains. The daemon reads service definitions from `~/.avm/config.yaml` and manages their lifecycle on the host.

**Tech Stack:** TypeScript, pnpm workspaces, Connect-ES (`@connectrpc/connect`, `@connectrpc/connect-node`), Buf for proto codegen, citty for CLIs, zx for shell operations, tsdown for bundling.

**Spec:** `docs/superpowers/specs/2026-04-16-host-services-design.md`

**Project principles (from CLAUDE.md):** No automated tests. Manual end-to-end testing only. All scripts in TypeScript/zx — no bash. Use `@clack/prompts` for interactive input. Temporary files in CWD, not `/tmp`.

---

## Phase 1: Workspace Migration

Move the existing monolith into `packages/avm/` and establish the workspace structure. This phase produces zero functional changes — everything works exactly as before, just reorganized.

### Task 1: Create workspace scaffold

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `packages/avm/package.json`
- Create: `packages/avm-daemon/package.json`
- Create: `packages/avm-bridge/package.json`
- Create: `packages/shared/package.json`
- Modify: root `package.json`
- Modify: root `tsdown.config.ts`

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create `packages/avm/package.json`**

```json
{
  "name": "@avm/cli",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@avm/shared": "workspace:*",
    "@clack/prompts": "^1.2.0",
    "@types/node": "^25.5.2",
    "@types/react": "^19.2.14",
    "citty": "^0.2.2",
    "ink": "^7.0.0",
    "react": "^19.2.5",
    "yaml": "^2.8.3",
    "zx": "^8.8.5"
  }
}
```

- [ ] **Step 3: Create `packages/avm-daemon/package.json`**

```json
{
  "name": "@avm/daemon",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@avm/shared": "workspace:*",
    "@connectrpc/connect": "^2.0.0",
    "@connectrpc/connect-node": "^2.0.0",
    "yaml": "^2.8.3",
    "zx": "^8.8.5"
  }
}
```

- [ ] **Step 4: Create `packages/avm-bridge/package.json`**

```json
{
  "name": "@avm/bridge",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@avm/shared": "workspace:*",
    "@connectrpc/connect": "^2.0.0",
    "@connectrpc/connect-node": "^2.0.0",
    "citty": "^0.2.2"
  }
}
```

- [ ] **Step 5: Create `packages/shared/package.json`**

```json
{
  "name": "@avm/shared",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./*": "./src/*.ts"
  },
  "dependencies": {
    "@bufbuild/protobuf": "^2.0.0",
    "@connectrpc/connect": "^2.0.0"
  }
}
```

- [ ] **Step 6: Strip root `package.json` to workspace root**

Replace root `package.json` with:

```json
{
  "name": "avm-workspace",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.28.0",
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "prepare": "tsdown"
  },
  "devDependencies": {
    "tsdown": "^0.21.7",
    "tsx": "^4.21.0",
    "typescript": "^6.0.2"
  }
}
```

- [ ] **Step 7: Update `tsdown.config.ts` for workspace entries**

```typescript
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "packages/avm/src/cli/avm.ts",
    "packages/avm-daemon/src/main.ts",
    "packages/avm-bridge/src/cli/avm-bridge.ts",
  ],
  format: "esm",
  platform: "node",
  deps: { neverBundle: [/^[^./]/] },
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
});
```

Note: tsdown will output `dist/avm.ts.mjs`, `dist/main.mjs`, `dist/avm-bridge.mjs` (based on entry file names). We may need to adjust naming — verify output filenames after first build and rename in the config if needed.

- [ ] **Step 8: Run `pnpm install` to link workspace packages**

Run: `pnpm install`
Expected: lockfile updates, workspace packages linked.

- [ ] **Step 9: Commit**

```
git add -A && git commit -m "Scaffold pnpm workspace with four packages"
```

### Task 2: Relocate existing code into `packages/avm/src/`

**Files:**
- Move: `cli/` → `packages/avm/src/cli/`
- Move: `lib/` → `packages/avm/src/lib/`
- Modify: all import paths in moved files
- Modify: `bin/avm.mjs` (update path to dist)

- [ ] **Step 1: Move directories**

```bash
mkdir -p packages/avm/src
mv cli packages/avm/src/cli
mv lib packages/avm/src/lib
```

- [ ] **Step 2: Update all relative imports**

Every file under `packages/avm/src/cli/commands/` imports from `../../lib/`. These paths are still correct after the move (the relative relationship is preserved since both `cli/` and `lib/` moved together). **Verify** by grepping:

```bash
grep -r 'from "../../lib/' packages/avm/src/cli/commands/
```

All paths should resolve. If `cli/avm.ts` imports from `./commands/`, those also remain valid.

- [ ] **Step 3: Update `bin/avm.mjs`**

Read the current `bin/avm.mjs` and update its import/exec path to point at the new `dist/` output. The wrapper likely does `import("../dist/avm.mjs")` or similar — update the path if the tsdown output filename changed.

- [ ] **Step 4: Build and verify**

Run: `pnpm run build`
Expected: `dist/` contains the host CLI bundle.

Run: `pnpm exec avm --help`
Expected: shows the help output with all subcommands.

- [ ] **Step 5: Commit**

```
git add -A && git commit -m "Relocate existing CLI code into packages/avm/src/"
```

---

## Phase 2: Proto + Codegen

### Task 3: Set up Buf and define protos

**Files:**
- Create: `buf.yaml`
- Create: `buf.gen.yaml`
- Create: `proto/avm/bridge/v1/services.proto`
- Create: `proto/avm/host/v1/containers.proto`
- Create: `proto/avm/host/v1/services.proto`

- [ ] **Step 1: Install Buf CLI**

Check if `buf` is available:
```bash
which buf
```

If not installed, install via Homebrew:
```bash
brew install bufbuild/buf/buf
```

- [ ] **Step 2: Install codegen dependencies**

```bash
pnpm add -D @bufbuild/buf @bufbuild/protoc-gen-es @connectrpc/protoc-gen-connect-es -w
```

(The `-w` flag adds to workspace root devDependencies.)

- [ ] **Step 3: Create `buf.yaml`**

```yaml
version: v2
modules:
  - path: proto
deps:
  - buf.build/googleapis/googleapis
```

- [ ] **Step 4: Create `buf.gen.yaml`**

```yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: packages/shared/src/gen
    opt:
      - target=ts
  - local: protoc-gen-connect-es
    out: packages/shared/src/gen
    opt:
      - target=ts
```

- [ ] **Step 5: Create `proto/avm/bridge/v1/services.proto`**

```protobuf
syntax = "proto3";
package avm.bridge.v1;

import "google/protobuf/timestamp.proto";

service ServicesService {
  rpc ListServices(ListServicesRequest) returns (ListServicesResponse);
  rpc GetService(GetServiceRequest) returns (Service);
  rpc StartService(StartServiceRequest) returns (Service);
  rpc StopService(StopServiceRequest) returns (Service);
}

message ListServicesRequest {}
message ListServicesResponse {
  repeated Service services = 1;
}

message GetServiceRequest {
  string name = 1;
}

message StartServiceRequest {
  string name = 1;
}

message StopServiceRequest {
  string name = 1;
}

message Service {
  string name = 1;
  Kind kind = 2;
  State state = 3;
  int32 pid = 4;
  string last_error = 5;
  google.protobuf.Timestamp last_check_at = 6;
}

enum Kind {
  KIND_UNSPECIFIED = 0;
  PROCESS = 1;
  DOCKER = 2;
}

enum State {
  STATE_UNSPECIFIED = 0;
  UP = 1;
  DOWN = 2;
  STARTING = 3;
  STOPPING = 4;
  UNKNOWN = 5;
}
```

- [ ] **Step 6: Create `proto/avm/host/v1/containers.proto`**

```protobuf
syntax = "proto3";
package avm.host.v1;

service ContainerService {
  rpc RegisterContainer(RegisterContainerRequest) returns (RegisterContainerResponse);
  rpc UnregisterContainer(UnregisterContainerRequest) returns (UnregisterContainerResponse);
}

message RegisterContainerRequest {
  string name = 1;
}

message RegisterContainerResponse {
  string token = 1;
}

message UnregisterContainerRequest {
  string name = 1;
}

message UnregisterContainerResponse {}
```

- [ ] **Step 7: Create `proto/avm/host/v1/services.proto`**

```protobuf
syntax = "proto3";
package avm.host.v1;

import "google/protobuf/timestamp.proto";

service ServicesService {
  rpc ListServices(ListServicesRequest) returns (ListServicesResponse);
  rpc GetService(GetServiceRequest) returns (Service);
  rpc StartService(StartServiceRequest) returns (Service);
  rpc StopService(StopServiceRequest) returns (Service);
}

message ListServicesRequest {}
message ListServicesResponse {
  repeated Service services = 1;
}

message GetServiceRequest {
  string name = 1;
}

message StartServiceRequest {
  string name = 1;
}

message StopServiceRequest {
  string name = 1;
}

message Service {
  string name = 1;
  Kind kind = 2;
  State state = 3;
  int32 pid = 4;
  string last_error = 5;
  google.protobuf.Timestamp last_check_at = 6;
}

enum Kind {
  KIND_UNSPECIFIED = 0;
  PROCESS = 1;
  DOCKER = 2;
}

enum State {
  STATE_UNSPECIFIED = 0;
  UP = 1;
  DOWN = 2;
  STARTING = 3;
  STOPPING = 4;
  UNKNOWN = 5;
}
```

- [ ] **Step 8: Run buf dep update and generate**

```bash
pnpm exec buf dep update
pnpm exec buf generate
```

Expected: TypeScript files appear under `packages/shared/src/gen/avm/bridge/v1/` and `packages/shared/src/gen/avm/host/v1/`.

- [ ] **Step 9: Add a `buf:generate` script to root `package.json`**

Add to the `"scripts"` section:
```json
"buf:generate": "buf dep update && buf generate"
```

- [ ] **Step 10: Commit**

```
git add -A && git commit -m "Add proto definitions and Buf codegen for bridge and host APIs"
```

---

## Phase 3: Shared Package — Client Factories

### Task 4: Create Connect client factories

**Files:**
- Create: `packages/shared/src/bridge-client.ts`
- Create: `packages/shared/src/host-client.ts`

- [ ] **Step 1: Create `packages/shared/src/bridge-client.ts`**

```typescript
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ServicesService } from "./gen/avm/bridge/v1/services_connect.js";

export function createBridgeServicesClient(port: number) {
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
  });
  return createClient(ServicesService, transport);
}

export { ServicesService } from "./gen/avm/bridge/v1/services_connect.js";
export * from "./gen/avm/bridge/v1/services_pb.js";
```

Note: the exact import paths for generated code depend on Buf output. After Task 3 step 8, inspect the actual filenames under `packages/shared/src/gen/` and adjust these imports. The `_connect.js` and `_pb.js` suffixes are the connect-es convention.

- [ ] **Step 2: Create `packages/shared/src/host-client.ts`**

```typescript
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ContainerService } from "./gen/avm/host/v1/containers_connect.js";
import { ServicesService } from "./gen/avm/host/v1/services_connect.js";

export function createHostContainerClient(port: number, hostSecret: string) {
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
    interceptors: [
      (next) => async (req) => {
        req.header.set("Authorization", `Bearer ${hostSecret}`);
        return next(req);
      },
    ],
  });
  return createClient(ContainerService, transport);
}

export function createHostServicesClient(port: number, hostSecret: string) {
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
    interceptors: [
      (next) => async (req) => {
        req.header.set("Authorization", `Bearer ${hostSecret}`);
        return next(req);
      },
    ],
  });
  return createClient(ServicesService, transport);
}

export { ContainerService } from "./gen/avm/host/v1/containers_connect.js";
export { ServicesService as HostServicesService } from "./gen/avm/host/v1/services_connect.js";
export * from "./gen/avm/host/v1/containers_pb.js";
export * from "./gen/avm/host/v1/services_pb.js";
```

- [ ] **Step 3: Verify build**

Run: `pnpm run build`
Expected: no import resolution errors.

- [ ] **Step 4: Commit**

```
git add -A && git commit -m "Add Connect client factories for bridge and host APIs"
```

---

## Phase 4: Config Parsing Extensions

### Task 5: Extend config.yaml parsing for `daemon` and `services` blocks

**Files:**
- Modify: `packages/avm/src/lib/config-file.ts`
- Modify: `packages/avm/src/lib/config.ts`

- [ ] **Step 1: Add types to `config-file.ts`**

Add after the existing `SymlinkMount` interface:

```typescript
export interface DaemonConfig {
  port: number;
}

export interface ServiceDefinition {
  kind: "process" | "docker";
  command?: string[];
  container?: string;
  check: ServiceCheck;
}

export interface ServiceCheck {
  tcp: string;
}
```

Update `AvmConfig`:

```typescript
export interface AvmConfig {
  editor?: EditorChoice;
  daemon: DaemonConfig;
  volumes: VolumeMount[];
  repos: Record<string, RepoConfig>;
  services: Record<string, ServiceDefinition>;
}
```

- [ ] **Step 2: Update the validation allowlist**

```typescript
const TOP_LEVEL_KEYS = new Set(["editor", "daemon", "volumes", "repos", "services"]);
```

- [ ] **Step 3: Add parsing functions**

Add these functions alongside the existing `parseEditor`, `parseVolumes`, etc.:

```typescript
const DEFAULT_DAEMON_PORT = 6970;

function parseDaemon(raw: unknown): DaemonConfig {
  if (raw === undefined) return { port: DEFAULT_DAEMON_PORT };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "daemon" must be a mapping (got ${describe(raw)}).`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const allowedKeys = new Set(["port"]);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `${avmConfigFile}: unknown key "${key}" under daemon. Allowed: ${[...allowedKeys].join(", ")}.`,
      );
    }
  }
  let port = DEFAULT_DAEMON_PORT;
  if (obj.port !== undefined) {
    if (typeof obj.port !== "number" || !Number.isInteger(obj.port) || obj.port < 1 || obj.port > 65535) {
      throw new Error(
        `${avmConfigFile}: daemon.port must be an integer between 1 and 65535 (got ${describe(obj.port)}).`,
      );
    }
    port = obj.port;
  }
  return { port };
}

const SERVICE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const VALID_KINDS = new Set(["process", "docker"]);

function parseServices(raw: unknown): Record<string, ServiceDefinition> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "services" must be a mapping (got ${describe(raw)}).`,
    );
  }
  const out: Record<string, ServiceDefinition> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SERVICE_NAME_RE.test(name)) {
      throw new Error(
        `${avmConfigFile}: services.${name} — name must contain only letters, digits, dots, underscores, and hyphens.`,
      );
    }
    out[name] = parseOneService(name, value);
  }
  return out;
}

function parseOneService(name: string, raw: unknown): ServiceDefinition {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: services.${name} must be a mapping (got ${describe(raw)}).`,
    );
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.kind !== "string" || !VALID_KINDS.has(obj.kind)) {
    throw new Error(
      `${avmConfigFile}: services.${name}.kind must be "process" or "docker" (got ${describe(obj.kind)}).`,
    );
  }
  const kind = obj.kind as "process" | "docker";

  let command: string[] | undefined;
  let container: string | undefined;

  if (kind === "process") {
    if (!Array.isArray(obj.command) || obj.command.length === 0 || !obj.command.every((c: unknown) => typeof c === "string")) {
      throw new Error(
        `${avmConfigFile}: services.${name}.command must be a non-empty list of strings.`,
      );
    }
    command = obj.command as string[];
  } else {
    if (typeof obj.container !== "string" || obj.container.length === 0) {
      throw new Error(
        `${avmConfigFile}: services.${name}.container must be a non-empty string.`,
      );
    }
    container = obj.container as string;
  }

  if (obj.check === undefined || obj.check === null || typeof obj.check !== "object" || Array.isArray(obj.check)) {
    throw new Error(
      `${avmConfigFile}: services.${name}.check must be a mapping.`,
    );
  }
  const checkObj = obj.check as Record<string, unknown>;
  if (typeof checkObj.tcp !== "string" || checkObj.tcp.length === 0) {
    throw new Error(
      `${avmConfigFile}: services.${name}.check.tcp must be a non-empty "host:port" string.`,
    );
  }
  const check: ServiceCheck = { tcp: checkObj.tcp };

  return { kind, command, container, check };
}
```

- [ ] **Step 4: Wire into the `validate` function**

Update the `validate` function to call the new parsers:

```typescript
function validate(data: unknown): AvmConfig {
  // ... existing checks ...

  const editor = parseEditor(obj.editor);
  const daemon = parseDaemon(obj.daemon);
  const volumes = parseVolumes(obj.volumes);
  const repos = parseRepos(obj.repos);
  const services = parseServices(obj.services);
  return { editor, daemon, volumes, repos, services };
}
```

Also update `loadAvmConfig` default return:

```typescript
export function loadAvmConfig(): AvmConfig {
  if (!existsSync(avmConfigFile)) {
    return { daemon: { port: DEFAULT_DAEMON_PORT }, volumes: [], repos: {}, services: {} };
  }
  // ...
}
```

- [ ] **Step 5: Add daemon paths to `config.ts`**

Add to `packages/avm/src/lib/config.ts`:

```typescript
export const avmDaemonDir = path.join(AVM_HOME, "daemon");
export const avmDaemonStateFile = path.join(avmDaemonDir, "state.json");
export const avmDaemonPidFile = path.join(avmDaemonDir, "daemon.pid");
export const avmDaemonLogFile = path.join(avmDaemonDir, "daemon.log");
export const avmDaemonHostSecretFile = path.join(avmDaemonDir, "host.secret");
export const DEFAULT_DAEMON_PORT = 6970;
```

- [ ] **Step 6: Build and verify**

Run: `pnpm run build`
Expected: compiles without errors.

- [ ] **Step 7: Commit**

```
git add -A && git commit -m "Extend config parsing for daemon and services blocks"
```

---

## Phase 5: Daemon — Core Server

### Task 6: Daemon state management

**Files:**
- Create: `packages/avm-daemon/src/state.ts`

- [ ] **Step 1: Create `packages/avm-daemon/src/state.ts`**

```typescript
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface DaemonState {
  containers: Record<string, { token: string; createdAt: string }>;
  servicePids: Record<string, number>;
}

export class StateStore {
  private state: DaemonState;
  private writing = false;
  private pendingWrite = false;

  constructor(private readonly path: string) {
    this.state = this.read();
  }

  private read(): DaemonState {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw);
      return {
        containers: parsed.containers ?? {},
        servicePids: parsed.servicePids ?? {},
      };
    } catch {
      return { containers: {}, servicePids: {} };
    }
  }

  private persist(): void {
    if (this.writing) {
      this.pendingWrite = true;
      return;
    }
    this.writing = true;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.path);
    } finally {
      this.writing = false;
      if (this.pendingWrite) {
        this.pendingWrite = false;
        this.persist();
      }
    }
  }

  registerContainer(name: string): string {
    const token = randomBytes(32).toString("base64url");
    this.state.containers[name] = {
      token,
      createdAt: new Date().toISOString(),
    };
    this.persist();
    return token;
  }

  unregisterContainer(name: string): void {
    delete this.state.containers[name];
    this.persist();
  }

  resolveToken(token: string): string | null {
    for (const [name, entry] of Object.entries(this.state.containers)) {
      if (entry.token === token) return name;
    }
    return null;
  }

  getServicePid(name: string): number | undefined {
    return this.state.servicePids[name];
  }

  setServicePid(name: string, pid: number): void {
    this.state.servicePids[name] = pid;
    this.persist();
  }

  clearServicePid(name: string): void {
    delete this.state.servicePids[name];
    this.persist();
  }
}
```

- [ ] **Step 2: Commit**

```
git add -A && git commit -m "Add daemon state store with atomic JSON persistence"
```

### Task 7: Daemon auth module

**Files:**
- Create: `packages/avm-daemon/src/auth.ts`

- [ ] **Step 1: Create `packages/avm-daemon/src/auth.ts`**

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { ConnectError, Code } from "@connectrpc/connect";
import type { StateStore } from "./state.js";

export interface AuthContext {
  containerName: string;
}

export function ensureHostSecret(secretPath: string): string {
  if (existsSync(secretPath)) {
    return readFileSync(secretPath, "utf8").trim();
  }
  const secret = randomBytes(32).toString("base64url");
  mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 });
  writeFileSync(secretPath, secret + "\n", { mode: 0o600 });
  return secret;
}

export function createHostAuthInterceptor(hostSecret: string) {
  return (next: any) => async (req: any) => {
    const authHeader = req.header.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/, "");
    if (token !== hostSecret) {
      throw new ConnectError("Invalid host secret", Code.Unauthenticated);
    }
    return next(req);
  };
}

export function createContainerAuthInterceptor(stateStore: StateStore) {
  return (next: any) => async (req: any) => {
    const authHeader = req.header.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/, "");
    const containerName = stateStore.resolveToken(token);
    if (!containerName) {
      throw new ConnectError("Invalid container token", Code.Unauthenticated);
    }
    (req as any).containerName = containerName;
    return next(req);
  };
}
```

- [ ] **Step 2: Commit**

```
git add -A && git commit -m "Add daemon auth: host secret and container token interceptors"
```

### Task 8: Service registry (domain logic)

**Files:**
- Create: `packages/avm-daemon/src/registry.ts`

- [ ] **Step 1: Create `packages/avm-daemon/src/registry.ts`**

This is the centralized domain logic that both bridge and host RPC handlers delegate to.

```typescript
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

export class ServiceRegistry {
  constructor(private readonly stateStore: StateStore) {}

  async getStatus(name: string, config: ServiceConfig): Promise<ServiceStatus> {
    const up = await this.checkHealth(config.check.tcp);
    const pid = this.stateStore.getServicePid(name) ?? 0;
    return {
      name,
      kind: config.kind,
      state: up ? "up" : "down",
      pid: up ? pid : 0,
      lastError: "",
      lastCheckAt: new Date(),
    };
  }

  async start(name: string, config: ServiceConfig): Promise<ServiceStatus> {
    if (await this.checkHealth(config.check.tcp)) {
      return this.getStatus(name, config);
    }

    if (config.kind === "process") {
      await this.startProcess(name, config.command!);
    } else {
      await this.startDockerContainer(config.container!);
    }

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.checkHealth(config.check.tcp)) {
        return this.getStatus(name, config);
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    return {
      name,
      kind: config.kind,
      state: "down",
      pid: 0,
      lastError: `Health check on ${config.check.tcp} did not pass within 10s after start`,
      lastCheckAt: new Date(),
    };
  }

  async stop(name: string, config: ServiceConfig): Promise<ServiceStatus> {
    if (!(await this.checkHealth(config.check.tcp))) {
      return this.getStatus(name, config);
    }

    if (config.kind === "process") {
      await this.stopProcess(name);
    } else {
      await this.stopDockerContainer(config.container!);
    }

    return this.getStatus(name, config);
  }

  private async startProcess(name: string, command: string[]): Promise<void> {
    const [bin, ...args] = command;
    const child = spawn(bin!, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (child.pid) {
      this.stateStore.setServicePid(name, child.pid);
    }
  }

  private async stopProcess(name: string): Promise<void> {
    const pid = this.stateStore.getServicePid(name);
    if (!pid) return;

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      this.stateStore.clearServicePid(name);
      return;
    }

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        this.stateStore.clearServicePid(name);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    this.stateStore.clearServicePid(name);
  }

  private async startDockerContainer(containerName: string): Promise<void> {
    await $`docker start ${containerName}`;
  }

  private async stopDockerContainer(containerName: string): Promise<void> {
    await $`docker stop ${containerName}`;
  }

  private checkHealth(tcpAddr: string): Promise<boolean> {
    return new Promise((resolve) => {
      const [host, portStr] = tcpAddr.split(":");
      const port = parseInt(portStr!, 10);
      const conn = createConnection({ host, port }, () => {
        conn.destroy();
        resolve(true);
      });
      conn.on("error", () => resolve(false));
      conn.setTimeout(1000, () => {
        conn.destroy();
        resolve(false);
      });
    });
  }
}
```

- [ ] **Step 2: Commit**

```
git add -A && git commit -m "Add service registry: domain logic for start/stop/health-check"
```

### Task 9: Daemon Connect server + RPC handlers

**Files:**
- Create: `packages/avm-daemon/src/server.ts`
- Create: `packages/avm-daemon/src/main.ts`

- [ ] **Step 1: Create `packages/avm-daemon/src/server.ts`**

```typescript
import { createConnectRouter } from "@connectrpc/connect";
import { ConnectError, Code } from "@connectrpc/connect";
import type { ServiceRegistry, ServiceConfig } from "./registry.js";
import type { StateStore } from "./state.js";

import { ServicesService as BridgeServicesService } from "@avm/shared/gen/avm/bridge/v1/services_connect.js";
import { ServicesService as HostServicesService } from "@avm/shared/gen/avm/host/v1/services_connect.js";
import { ContainerService } from "@avm/shared/gen/avm/host/v1/containers_connect.js";

type ConfigLoader = () => Record<string, ServiceConfig>;

function serviceHandlers(registry: ServiceRegistry, loadConfig: ConfigLoader) {
  function getServiceConfig(name: string): ServiceConfig {
    const config = loadConfig();
    const svc = config[name];
    if (!svc) {
      throw new ConnectError(`Unknown service "${name}"`, Code.NotFound);
    }
    return svc;
  }

  return {
    async listServices() {
      const config = loadConfig();
      const statuses = await Promise.all(
        Object.entries(config).map(([name, cfg]) => registry.getStatus(name, cfg)),
      );
      return { services: statuses };
    },

    async getService(req: { name: string }) {
      const cfg = getServiceConfig(req.name);
      return registry.getStatus(req.name, cfg);
    },

    async startService(req: { name: string }) {
      const cfg = getServiceConfig(req.name);
      return registry.start(req.name, cfg);
    },

    async stopService(req: { name: string }) {
      const cfg = getServiceConfig(req.name);
      return registry.stop(req.name, cfg);
    },
  };
}

export function createRouter(
  registry: ServiceRegistry,
  stateStore: StateStore,
  loadConfig: ConfigLoader,
) {
  const handlers = serviceHandlers(registry, loadConfig);

  return createConnectRouter((router) => {
    router.service(BridgeServicesService, handlers);
    router.service(HostServicesService, handlers);
    router.service(ContainerService, {
      async registerContainer(req) {
        const token = stateStore.registerContainer(req.name);
        return { token };
      },
      async unregisterContainer(req) {
        stateStore.unregisterContainer(req.name);
        return {};
      },
    });
  });
}
```

Note: the import paths for generated service definitions depend on the actual Buf output filenames. Adjust after codegen runs. The key pattern: both `BridgeServicesService` and `HostServicesService` share the same `handlers` object — thin routers over the same domain logic.

- [ ] **Step 2: Create `packages/avm-daemon/src/main.ts`**

```typescript
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { StateStore } from "./state.js";
import { ServiceRegistry } from "./registry.js";
import { ensureHostSecret, createHostAuthInterceptor, createContainerAuthInterceptor } from "./auth.js";
import { createRouter } from "./server.js";

const AVM_HOME = process.env.HOME
  ? `${process.env.HOME}/.avm`
  : "/tmp/.avm";

const daemonDir = `${AVM_HOME}/daemon`;
const stateFile = `${daemonDir}/state.json`;
const secretFile = `${daemonDir}/host.secret`;
const pidFile = `${daemonDir}/daemon.pid`;
const configFile = `${AVM_HOME}/config.yaml`;

function loadServicesConfig(): Record<string, import("./registry.js").ServiceConfig> {
  try {
    const raw = readFileSync(configFile, "utf8");
    const { parseDocument } = await import("yaml");
    const doc = parseDocument(raw);
    const data = doc.toJS() ?? {};
    return data.services ?? {};
  } catch {
    return {};
  }
}

async function main() {
  mkdirSync(daemonDir, { recursive: true, mode: 0o700 });

  const hostSecret = ensureHostSecret(secretFile);
  const stateStore = new StateStore(stateFile);
  const registry = new ServiceRegistry(stateStore);

  const router = createRouter(registry, stateStore, loadServicesConfig);

  const handler = connectNodeAdapter({ routes: router });

  // Read port from config, default 6970
  let port = 6970;
  try {
    const raw = readFileSync(configFile, "utf8");
    const { parseDocument } = await import("yaml");
    const doc = parseDocument(raw);
    const data = doc.toJS() ?? {};
    port = data?.daemon?.port ?? 6970;
  } catch {
    // use default
  }

  const server = http.createServer(handler);
  server.listen(port, "127.0.0.1", () => {
    console.log(`avm-daemon listening on 127.0.0.1:${port}`);
  });

  // Write PID file
  writeFileSync(pidFile, String(process.pid) + "\n", { mode: 0o600 });

  // Cleanup on exit
  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down...");
    server.close();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down...");
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

Note: the `loadServicesConfig` function uses a dynamic import for `yaml` to keep the config-reading lazy. This function is called on every RPC to get fresh config. The auth interceptors need to be wired into the router — the exact mechanism depends on Connect-ES router API. If per-service interceptors aren't supported at the router level, wrap the handler with middleware on the `http.createServer` side that checks the path prefix (`/avm.host.v1/` vs `/avm.bridge.v1/`) and applies the appropriate auth check. Resolve this during implementation.

- [ ] **Step 3: Build and verify the daemon starts**

Run: `pnpm run build`
Then: `node dist/main.mjs`
Expected: prints `avm-daemon listening on 127.0.0.1:6970`

Kill with Ctrl-C.

- [ ] **Step 4: Commit**

```
git add -A && git commit -m "Add daemon server: Connect router, auth, HTTP listener"
```

---

## Phase 6: Host CLI — Daemon Management

### Task 10: `avm daemon` subcommand

**Files:**
- Create: `packages/avm/src/cli/commands/daemon.ts`
- Modify: `packages/avm/src/cli/avm.ts`

- [ ] **Step 1: Create `packages/avm/src/cli/commands/daemon.ts`**

```typescript
import { defineCommand } from "citty";
import { $ } from "zx";
import { readFileSync, existsSync } from "node:fs";
import {
  avmDaemonDir,
  avmDaemonPidFile,
  avmDaemonLogFile,
  avmDaemonHostSecretFile,
  DEFAULT_DAEMON_PORT,
} from "../../lib/config.ts";
import { loadAvmConfig } from "../../lib/config-file.ts";

async function isDaemonReachable(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/`);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  try {
    const raw = readFileSync(avmDaemonPidFile, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

const startCommand = defineCommand({
  meta: { name: "start", description: "Start the avm daemon." },
  async run() {
    const config = loadAvmConfig();
    const port = config.daemon.port;

    if (await isDaemonReachable(port)) {
      console.log(`Daemon already running on 127.0.0.1:${port}`);
      return;
    }

    console.log(`Starting daemon on 127.0.0.1:${port}...`);
    // Find the daemon binary relative to this CLI's location
    const daemonBin = new URL("../../../dist/main.mjs", import.meta.url).pathname;
    await $`node ${daemonBin} > ${avmDaemonLogFile} 2>&1 &`.nothrow();

    // Wait for it to become reachable
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await isDaemonReachable(port)) {
        console.log("Daemon started.");
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    console.error("Daemon did not become reachable within 5s. Check logs at", avmDaemonLogFile);
    process.exit(1);
  },
});

const stopCommand = defineCommand({
  meta: { name: "stop", description: "Stop the avm daemon." },
  async run() {
    const pid = readPid();
    if (!pid) {
      console.log("Daemon is not running.");
      return;
    }
    console.log(`Stopping daemon (PID ${pid})...`);
    process.kill(pid, "SIGTERM");
    console.log("Stopped.");
  },
});

const statusCommand = defineCommand({
  meta: { name: "status", description: "Show daemon status." },
  async run() {
    const config = loadAvmConfig();
    const port = config.daemon.port;
    const reachable = await isDaemonReachable(port);
    const pid = readPid();

    console.log(`URL:       http://127.0.0.1:${port}`);
    console.log(`PID:       ${pid ?? "not running"}`);
    console.log(`Reachable: ${reachable ? "yes" : "no"}`);
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
```

Note: the `install`/`uninstall` launchd subcommands are deferred — they're not on the critical path for the service feature. Add them as a follow-up task.

- [ ] **Step 2: Register in `cli/avm.ts`**

Add import:
```typescript
import { daemonCommand } from "./commands/daemon.ts";
```

Add to `subCommands`:
```typescript
daemon: daemonCommand,
```

- [ ] **Step 3: Build and test**

Run: `pnpm run build`
Run: `pnpm exec avm daemon status`
Expected: shows URL, PID (not running), Reachable: no.

Run: `pnpm exec avm daemon start`
Expected: starts the daemon, prints confirmation.

Run: `pnpm exec avm daemon status`
Expected: shows PID and Reachable: yes.

Run: `pnpm exec avm daemon stop`
Expected: stops the daemon.

- [ ] **Step 4: Commit**

```
git add -A && git commit -m "Add 'avm daemon start|stop|status' subcommand"
```

### Task 11: `avm service` subcommand

**Files:**
- Create: `packages/avm/src/cli/commands/service.ts`
- Modify: `packages/avm/src/cli/avm.ts`

- [ ] **Step 1: Create `packages/avm/src/cli/commands/service.ts`**

```typescript
import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { loadAvmConfig } from "../../lib/config-file.ts";
import { avmDaemonHostSecretFile } from "../../lib/config.ts";
import { createHostServicesClient } from "@avm/shared/host-client.js";

function getClient() {
  const config = loadAvmConfig();
  const secret = readFileSync(avmDaemonHostSecretFile, "utf8").trim();
  return createHostServicesClient(config.daemon.port, secret);
}

const lsCommand = defineCommand({
  meta: { name: "ls", description: "List all declared services." },
  async run() {
    const client = getClient();
    const resp = await client.listServices({});
    if (resp.services.length === 0) {
      console.log("No services declared in ~/.avm/config.yaml");
      return;
    }
    for (const svc of resp.services) {
      const state = svc.state === 1 ? "UP" : svc.state === 2 ? "DOWN" : "UNKNOWN";
      const kind = svc.kind === 1 ? "process" : svc.kind === 2 ? "docker" : "?";
      console.log(`${svc.name.padEnd(20)} ${kind.padEnd(10)} ${state}`);
    }
  },
});

const statusCmd = defineCommand({
  meta: { name: "status", description: "Show status of a service." },
  args: {
    name: { type: "positional", required: true, description: "Service name" },
  },
  async run({ args }) {
    const client = getClient();
    const svc = await client.getService({ name: args.name as string });
    console.log(`Name:  ${svc.name}`);
    console.log(`Kind:  ${svc.kind === 1 ? "process" : "docker"}`);
    console.log(`State: ${svc.state === 1 ? "UP" : svc.state === 2 ? "DOWN" : "UNKNOWN"}`);
    if (svc.pid) console.log(`PID:   ${svc.pid}`);
    if (svc.lastError) console.log(`Error: ${svc.lastError}`);
  },
});

const startCmd = defineCommand({
  meta: { name: "start", description: "Start a service." },
  args: {
    name: { type: "positional", required: true, description: "Service name" },
  },
  async run({ args }) {
    const client = getClient();
    const svc = await client.startService({ name: args.name as string });
    const state = svc.state === 1 ? "UP" : "FAILED";
    console.log(`${svc.name}: ${state}`);
    if (svc.lastError) console.log(`Error: ${svc.lastError}`);
  },
});

const stopCmd = defineCommand({
  meta: { name: "stop", description: "Stop a service." },
  args: {
    name: { type: "positional", required: true, description: "Service name" },
  },
  async run({ args }) {
    const client = getClient();
    const svc = await client.stopService({ name: args.name as string });
    const state = svc.state === 2 ? "DOWN" : "STILL_UP";
    console.log(`${svc.name}: ${state}`);
  },
});

export const serviceCommand = defineCommand({
  meta: { name: "service", description: "Manage host services." },
  subCommands: {
    ls: lsCommand,
    status: statusCmd,
    start: startCmd,
    stop: stopCmd,
  },
});
```

Note: the enum integer comparisons (`svc.state === 1`) correspond to the proto enum values. In practice, the generated code may expose string enums or objects — adjust to match the actual codegen output.

- [ ] **Step 2: Register in `cli/avm.ts`**

Add import:
```typescript
import { serviceCommand } from "./commands/service.ts";
```

Add to `subCommands`:
```typescript
service: serviceCommand,
```

- [ ] **Step 3: End-to-end test**

1. Add to `~/.avm/config.yaml`:
```yaml
services:
  chrome:
    kind: process
    command:
      - /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
      - --remote-debugging-port=9222
      - --user-data-dir=/tmp/chrome-devtools-profile
    check:
      tcp: 127.0.0.1:9222
```

2. Start daemon: `pnpm exec avm daemon start`
3. Run: `pnpm exec avm service ls`
   Expected: shows `chrome` with state DOWN.
4. Run: `pnpm exec avm service start chrome`
   Expected: Chrome launches, shows state UP.
5. Run: `pnpm exec avm service status chrome`
   Expected: shows UP with PID.
6. Run: `pnpm exec avm service stop chrome`
   Expected: Chrome stops, shows DOWN.

- [ ] **Step 4: Commit**

```
git add -A && git commit -m "Add 'avm service ls|status|start|stop' subcommand"
```

---

## Phase 7: avm-bridge CLI

### Task 12: Build the avm-bridge CLI

**Files:**
- Create: `packages/avm-bridge/src/cli/avm-bridge.ts`
- Create: `packages/avm-bridge/src/cli/commands/service.ts`

- [ ] **Step 1: Create `packages/avm-bridge/src/cli/commands/service.ts`**

```typescript
import { defineCommand } from "citty";
import { createBridgeServicesClient } from "@avm/shared/bridge-client.js";

function getClient() {
  const port = process.env.AVM_HOST_PORT;
  if (!port) {
    console.error("Error: AVM_HOST_PORT is not set. Are you inside an avm container?");
    process.exit(1);
  }
  const token = process.env.AVM_HOST_TOKEN;
  if (!token) {
    console.error("Error: AVM_HOST_TOKEN is not set. Container was not registered with the daemon.");
    process.exit(1);
  }
  // The bridge client needs to send the token as Authorization header.
  // We'll need to either modify createBridgeServicesClient to accept a token,
  // or create the transport inline here.
  return createBridgeServicesClient(parseInt(port, 10));
}

const lsCommand = defineCommand({
  meta: { name: "ls", description: "List all declared services." },
  async run() {
    const client = getClient();
    const resp = await client.listServices({});
    if (resp.services.length === 0) {
      console.log("No services declared.");
      return;
    }
    for (const svc of resp.services) {
      const state = svc.state === 1 ? "UP" : svc.state === 2 ? "DOWN" : "UNKNOWN";
      console.log(`${svc.name.padEnd(20)} ${state}`);
    }
  },
});

const statusCmd = defineCommand({
  meta: { name: "status", description: "Show status of a service." },
  args: {
    name: { type: "positional", required: true, description: "Service name" },
  },
  async run({ args }) {
    const client = getClient();
    const svc = await client.getService({ name: args.name as string });
    console.log(`Name:  ${svc.name}`);
    console.log(`State: ${svc.state === 1 ? "UP" : svc.state === 2 ? "DOWN" : "UNKNOWN"}`);
    if (svc.lastError) console.log(`Error: ${svc.lastError}`);
  },
});

const startCmd = defineCommand({
  meta: { name: "start", description: "Start a service." },
  args: {
    name: { type: "positional", required: true, description: "Service name" },
  },
  async run({ args }) {
    const client = getClient();
    const svc = await client.startService({ name: args.name as string });
    const state = svc.state === 1 ? "UP" : "FAILED";
    console.log(`${svc.name}: ${state}`);
    if (svc.lastError) console.log(`Error: ${svc.lastError}`);
  },
});

const stopCmd = defineCommand({
  meta: { name: "stop", description: "Stop a service." },
  args: {
    name: { type: "positional", required: true, description: "Service name" },
  },
  async run({ args }) {
    const client = getClient();
    const svc = await client.stopService({ name: args.name as string });
    const state = svc.state === 2 ? "DOWN" : "STILL_UP";
    console.log(`${svc.name}: ${state}`);
  },
});

export const serviceCommand = defineCommand({
  meta: { name: "service", description: "Manage host services." },
  subCommands: {
    ls: lsCommand,
    status: statusCmd,
    start: startCmd,
    stop: stopCmd,
  },
});
```

Note: `createBridgeServicesClient` in Task 4 doesn't accept a token. Update it to accept an optional token parameter and add an Authorization header interceptor (same pattern as the host client). Do this when implementing — the exact change is: add a `token?: string` parameter, and if provided, add an interceptor that sets `Authorization: Bearer ${token}`.

- [ ] **Step 2: Create `packages/avm-bridge/src/cli/avm-bridge.ts`**

```typescript
import { defineCommand, runMain } from "citty";
import { serviceCommand } from "./commands/service.ts";

const main = defineCommand({
  meta: {
    name: "avm-bridge",
    description: "avm bridge: coordinate with the host control plane.",
  },
  subCommands: {
    service: serviceCommand,
  },
});

runMain(main);
```

- [ ] **Step 3: Build and verify**

Run: `pnpm run build`
Expected: `dist/avm-bridge.mjs` is produced.

Run: `node dist/avm-bridge.mjs --help`
Expected: shows help with `service` subcommand.

Run: `AVM_HOST_PORT=6970 AVM_HOST_TOKEN=fake node dist/avm-bridge.mjs service ls`
Expected: connection error or auth error (daemon must be running). This confirms the CLI wiring works.

- [ ] **Step 4: Commit**

```
git add -A && git commit -m "Add avm-bridge CLI with service subcommand"
```

---

## Phase 8: Container Integration

### Task 13: Wire token registration into `avm create` and `avm clean`

**Files:**
- Modify: `packages/avm/src/cli/commands/create.ts`
- Modify: `packages/avm/src/cli/commands/clean.ts`
- Modify: `packages/avm/src/lib/session.ts`
- Modify: `packages/avm/src/lib/config.ts`

- [ ] **Step 1: Add daemon helper to `config.ts`**

Add to `packages/avm/src/lib/config.ts`:

```typescript
export function repoDistDir(): string {
  return new URL("../../../dist", import.meta.url).pathname;
}
```

- [ ] **Step 2: Add daemon-ensure utility to `session.ts`**

Add to `packages/avm/src/lib/session.ts`:

```typescript
import { readFileSync, existsSync } from "node:fs";
import { avmDaemonHostSecretFile, avmDaemonLogFile, DEFAULT_DAEMON_PORT, repoDistDir } from "./config.ts";
import { loadAvmConfig } from "./config-file.ts";
import { createHostContainerClient } from "@avm/shared/host-client.js";
import { $ } from "zx";

export async function ensureDaemonRunning(): Promise<{ port: number; secret: string }> {
  const config = loadAvmConfig();
  const port = config.daemon.port;

  // Check if already reachable
  const reachable = await fetch(`http://127.0.0.1:${port}/`).then(() => true).catch(() => false);
  if (!reachable) {
    const daemonBin = `${repoDistDir()}/main.mjs`;
    console.log("==> Starting avm daemon...");
    await $`node ${daemonBin} >> ${avmDaemonLogFile} 2>&1 &`.nothrow();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await fetch(`http://127.0.0.1:${port}/`).then(() => true).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const secret = readFileSync(avmDaemonHostSecretFile, "utf8").trim();
  return { port, secret };
}

export async function registerContainer(name: string): Promise<string> {
  const { port, secret } = await ensureDaemonRunning();
  const client = createHostContainerClient(port, secret);
  const resp = await client.registerContainer({ name });
  return resp.token;
}

export async function unregisterContainer(name: string): Promise<void> {
  try {
    const config = loadAvmConfig();
    const port = config.daemon.port;
    const secret = readFileSync(avmDaemonHostSecretFile, "utf8").trim();
    const client = createHostContainerClient(port, secret);
    await client.unregisterContainer({ name });
  } catch {
    // Daemon might not be running during cleanup — that's fine
  }
}
```

- [ ] **Step 3: Update `create.ts` to register token and pass env vars**

In `create.ts`, after `ensureHostScaffolding()` and before `docker run`, add:

```typescript
const token = await registerContainer(vmName);
```

Import `registerContainer` from `../../lib/session.ts`.

Add to the `docker run` args array (alongside existing `-e` flags):

```typescript
"-e", `AVM_HOST_PORT=${config.daemon.port}`,
"-e", `AVM_HOST_TOKEN=${token}`,
"-e", `AVM_CONTAINER_NAME=${vmName}`,
```

- [ ] **Step 4: Add bridge mount to `getDockerMountArgs`**

In `session.ts`, add to the `fixedMounts` array:

```typescript
[`${repoDistDir()}/avm-bridge.mjs`, "/usr/local/bin/avm-bridge"],
```

Note: the bind-mounted file needs to be executable. After the `docker run`, add a post-creation step:

```typescript
await $`docker exec -u root ${containerName} chmod +x /usr/local/bin/avm-bridge`;
```

Add this to `applyPostCreationSetup`.

- [ ] **Step 5: Update `clean.ts` to unregister**

In the cleanup loop, before `docker rm -f`, add:

```typescript
await unregisterContainer(target.name);
```

Import `unregisterContainer` from `../../lib/session.ts`.

- [ ] **Step 6: Build and test end-to-end**

1. `pnpm run build`
2. `pnpm exec avm daemon start`
3. `pnpm exec avm create --attach`
4. Inside the container: `avm-bridge service ls`
   Expected: shows declared services.
5. Inside the container: `avm-bridge service start chrome`
   Expected: Chrome launches on the host.
6. Exit container.
7. `pnpm exec avm clean <id>`
   Expected: container cleaned, token unregistered.

- [ ] **Step 7: Commit**

```
git add -A && git commit -m "Wire daemon registration into avm create/clean, mount avm-bridge"
```

---

## Phase 9: Agent Guidance

### Task 14: Generate `host-services.md` sidecar in containers

**Files:**
- Modify: `packages/avm/src/lib/session.ts`
- Modify: `templates/vm-claude.md`

- [ ] **Step 1: Add sidecar generation to `applyPostCreationSetup`**

Add a new function and call it from `applyPostCreationSetup`:

```typescript
async function writeHostServicesSidecar(
  containerName: string,
  config: AvmConfig,
): Promise<void> {
  const serviceEntries = Object.entries(config.services);
  if (serviceEntries.length === 0) return;

  const lines = [
    "# Host Services",
    "",
    "Services running on the host are controllable via `avm-bridge`. Use the",
    "host copy rather than starting your own — especially when a project's",
    "README or `docker-compose.yaml` suggests running them locally.",
    "",
    "## Available services",
    "",
  ];

  for (const [name, svc] of serviceEntries) {
    const kind = svc.kind === "process" ? "host process" : "host docker container";
    const port = svc.check.tcp.split(":")[1] ?? "";
    lines.push(`- **${name}** (${kind}) — on \`${svc.check.tcp}\``);
  }

  lines.push("");
  lines.push("## Usage");
  lines.push("");
  lines.push("    avm-bridge service status <name>");
  lines.push("    avm-bridge service start  <name>");
  lines.push("    avm-bridge service stop   <name>");
  lines.push("    avm-bridge service ls");
  lines.push("");
  lines.push("Services are started on request (idempotent). They may stop at any");
  lines.push("time — crashes, user-initiated, another agent stopping them. Always");
  lines.push("check status before use and be prepared to restart.");
  lines.push("");

  const content = lines.join("\n");
  const cmd = `mkdir -p /home/agent/.claude && cat > /home/agent/.claude/host-services.md`;
  await $({ input: content })`docker exec -i ${containerName} bash -c ${cmd}`;
  await $`docker exec -u root ${containerName} chown agent:agent /home/agent/.claude/host-services.md`;
}
```

Call this at the end of `applyPostCreationSetup`:

```typescript
await writeHostServicesSidecar(containerName, config);
```

- [ ] **Step 2: Update `templates/vm-claude.md`**

Add to the end of the file:

```markdown

## Host services

If `~/.claude/host-services.md` exists, read it for information about
services running on the host machine and how to control them via
`avm-bridge`.
```

- [ ] **Step 3: Test by creating a container and checking the file**

1. `pnpm run build`
2. `pnpm exec avm create --attach`
3. Inside: `cat ~/.claude/host-services.md`
   Expected: shows the generated host services content.
4. Inside: `cat ~/.claude/CLAUDE.md`
   Expected: includes the "Host services" section pointing at the sidecar.

- [ ] **Step 4: Commit**

```
git add -A && git commit -m "Generate host-services.md sidecar in containers"
```

---

## Phase 10: Documentation + Examples

### Task 15: Update docs and examples

**Files:**
- Create: `examples/config.yaml`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create `examples/config.yaml`**

```yaml
# ~/.avm/config.yaml — example with host services

# Editor for 'avm-bridge editor open' (also used by 'avm editor')
editor: cursor

# Daemon configuration
daemon:
  port: 6970

# Bind mounts applied to every session container
volumes:
  - pnpm-store:~/.local/share/pnpm/store

# Host services — started/stopped on demand by agents via avm-bridge
services:
  chrome:
    kind: process
    command:
      - /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
      - --remote-debugging-port=9222
      - --user-data-dir=/tmp/chrome-devtools-profile
    check:
      tcp: 127.0.0.1:9222

  # Example: postgres in a host docker container
  # postgres:
  #   kind: docker
  #   container: local-postgres
  #   check:
  #     tcp: 127.0.0.1:5432

# Per-repo config
repos:
  my-project:
    symlinks:
      - envs/my-project.env:.env
```

- [ ] **Step 2: Update README.md**

Add a "Host Services" section after the "Customizing" section. Add `~/.avm/daemon/` to the "Host Data Layout" diagram:

```markdown
## Host Services

Agents inside containers can start, stop, and check host-side services
(Chrome, Postgres, etc.) via the `avm-bridge` CLI. The host-side
`avm daemon` process manages service lifecycle.

### Quick start

1. Declare services in `~/.avm/config.yaml` (see `examples/config.yaml`):

   ```yaml
   services:
     chrome:
       kind: process
       command:
         - /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
         - --remote-debugging-port=9222
         - --user-data-dir=/tmp/chrome-devtools-profile
       check:
         tcp: 127.0.0.1:9222
   ```

2. Start the daemon (auto-started by `avm create` if not running):

   ```bash
   avm daemon start
   ```

3. From inside a container, agents use `avm-bridge`:

   ```bash
   avm-bridge service start chrome
   avm-bridge service status chrome
   avm-bridge service stop chrome
   ```

4. From the host, the user can also manage services:

   ```bash
   avm service start chrome
   avm service ls
   ```
```

Add to the Host Data Layout:
```
├── daemon/               # managed by avm daemon
│   ├── host.secret       # host CLI auth (never mounted into containers)
│   ├── state.json        # daemon-internal state
│   ├── daemon.pid        # daemon PID
│   └── daemon.log        # daemon logs
```

- [ ] **Step 3: Update CLAUDE.md File Structure section**

Replace the current File Structure block to reflect the workspace layout. Update the "When Modifying" section to mention the daemon and bridge packages.

- [ ] **Step 4: Commit**

```
git add -A && git commit -m "Document host services in README, examples, and CLAUDE.md"
```

---

## Implementation Notes

**Auth interceptor wiring.** The spec requires that `avm.host.v1` RPCs use host-secret auth and `avm.bridge.v1` RPCs use container-token auth. Connect-ES routers may not support per-service interceptors directly. The implementation should use HTTP-level middleware that inspects the request path prefix to determine which auth check to apply:
- Paths starting with `/avm.host.v1.` → host secret check
- Paths starting with `/avm.bridge.v1.` → container token check

**Codegen import paths.** All `import` paths for generated code (e.g. `*_connect.js`, `*_pb.js`) are approximate. The exact filenames depend on the Buf plugin versions. After running `buf generate` in Task 3, inspect `packages/shared/src/gen/` and adjust all import paths in Tasks 4, 9, 11, 12.

**tsdown multi-entry output names.** tsdown may name outputs based on the entry filename (e.g. `avm.mjs`, `main.mjs`, `avm-bridge.mjs`). Verify after the first build and adjust `bin/avm.mjs` and the daemon-spawn path in Task 10 accordingly.

**`$` shell detach for daemon spawn.** The zx `$` template doesn't support `&` for backgrounding. Use `spawn` from `node:child_process` with `detached: true` and `stdio: 'ignore'` instead, then `child.unref()`. Adjust Tasks 10 and 13 accordingly during implementation.
