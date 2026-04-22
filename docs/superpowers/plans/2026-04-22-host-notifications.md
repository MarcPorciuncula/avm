# Host notifications — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Claude Code's `Notification` and `Stop` hooks inside an avm
container through avm-bridge to avm-daemon, which plays a sound and posts a
macOS notification on the host. Add host CLI commands to install/uninstall/
mute the feature, and a one-time first-run prompt in `avm provision` and
`avm start`.

**Architecture:**
- New bridge proto `NotificationService.Notify(NotificationKind, cwd?, session_id?)`.
- New bridge subcommand `avm-bridge claude-hook <event-name>` that reads
  Claude hook stdin JSON and forwards to the daemon.
- New daemon handler that resolves sound from `~/.avm/config.yaml`, plays
  with `afplay`, and posts via `osascript`.
- New host CLI command group `avm notify {install,uninstall,status,mute,unmute}`
  that manages `~/.avm/system/claude/settings.json` and config/state files.
- First-run prompt in `avm provision` and `avm start`, gated on
  `~/.avm/state.json` `notifications.installPrompt`.

**Tech stack:** Connect RPC (`@connectrpc/connect`, `@connectrpc/connect-node`),
buf-generated TS protos via `pnpm buf:generate`, citty CLI commands,
`@clack/prompts` for prompts, `yaml` for config, `node:child_process` for
`afplay`/`osascript`. No automated tests — verification is manual end-to-end
(per project convention).

**Build commands:**
- `pnpm build` — compile all workspaces.
- `pnpm buf:generate` — regenerate proto TS bindings into
  `packages/shared/src/gen/`.
- `pnpm exec tsdown` — runs `prepare` script (build).

**Reference reading before starting:**
- `docs/superpowers/specs/2026-04-22-host-notifications-design.md` — full
  design (problem, decisions, edge cases).
- `proto/avm/bridge/v1/editor.proto` — proto file shape to mirror.
- `packages/avm-bridge/src/cli/commands/editor.ts` — bridge command shape.
- `packages/avm-daemon/src/server.ts` — Connect router shape with auth.
- `packages/avm-daemon/src/editor.ts` — example handler that spawns processes.
- `packages/avm/src/cli/commands/ssh-config.ts` — install/uninstall command
  pattern with state.json gating (closest analog to `avm notify`).
- `packages/avm/src/lib/state.ts` — `readState`/`updateState` for state.json.
- `packages/avm/src/lib/config-file.ts` — config.yaml schema validation.

---

## File structure

**New files:**
- `proto/avm/bridge/v1/notification.proto` — proto definition.
- `packages/avm-bridge/src/cli/commands/claude-hook.ts` — bridge CLI subcommand.
- `packages/avm-daemon/src/notifications.ts` — daemon handler (sound + osascript).
- `packages/avm/src/lib/notify-hooks.ts` — pure logic for editing
  `settings.json` (install/uninstall hook entries).
- `packages/avm/src/cli/commands/notify.ts` — host CLI command group.

**Modified files:**
- `packages/shared/src/bridge-client.ts` — add `createBridgeNotificationClient`.
- `packages/avm-daemon/src/server.ts` — register `NotificationService` route.
- `packages/avm-bridge/src/cli/avm-bridge.ts` — wire `claude-hook` subcommand.
- `packages/avm/src/cli/avm.ts` — wire `notify` subcommand.
- `packages/avm/src/lib/config-file.ts` — extend `AvmConfig` schema with
  `notifications` block + parser/validator.
- `packages/avm/src/lib/state.ts` — extend `AvmState` with `notifications.installPrompt`.
- `packages/avm/src/cli/commands/provision.ts` — fire first-run prompt.
- `packages/avm/src/cli/commands/start.ts` — fire first-run prompt as fallback.
- `examples/config.yaml` — add commented-out `notifications:` example block.

---

## Task 1: Add the bridge proto and regenerate bindings

**Files:**
- Create: `proto/avm/bridge/v1/notification.proto`

- [ ] **Step 1: Create the proto file**

Create `proto/avm/bridge/v1/notification.proto` with this exact content:

```proto
syntax = "proto3";
package avm.bridge.v1;

service NotificationService {
  rpc Notify(NotifyRequest) returns (NotifyResponse);
}

enum NotificationKind {
  NOTIFICATION_KIND_UNSPECIFIED     = 0;
  NOTIFICATION_KIND_NEEDS_ATTENTION = 1;
  NOTIFICATION_KIND_COMPLETE        = 2;
}

message NotifyRequest {
  NotificationKind kind = 1;
  optional string cwd = 2;
  optional string session_id = 3;
}

message NotifyResponse {}
```

- [ ] **Step 2: Regenerate proto bindings**

Run: `pnpm buf:generate`
Expected: command exits 0; new file
`packages/shared/src/gen/avm/bridge/v1/notification_pb.ts` is created with
exports including `NotificationService`, `NotifyRequest`, `NotifyResponse`,
`NotifyResponseSchema`, `NotifyRequestSchema`, and `NotificationKind` enum.

If the file is not created, check `buf.gen.yaml` and that the proto file is
discoverable (it should be — buf scans the `proto/` tree).

- [ ] **Step 3: Verify the generated bindings compile**

Run: `pnpm build`
Expected: build succeeds, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add proto/avm/bridge/v1/notification.proto packages/shared/src/gen/avm/bridge/v1/notification_pb.ts
git commit -m "Add NotificationService proto for host notifications

The bridge service hooks call to send a notification kind plus optional
Claude hook context (cwd, session id) to the daemon, which dispatches a
macOS notification and sound on the host."
```

---

## Task 2: Export a typed bridge client for NotificationService

**Files:**
- Modify: `packages/shared/src/bridge-client.ts`

- [ ] **Step 1: Add re-exports and a client factory**

Open `packages/shared/src/bridge-client.ts` and add the following imports
and exports. Place the `NotificationService` import alongside the existing
ones near the top, the type re-exports alongside the existing groups, and
the new factory function at the bottom of the file.

Add to imports:
```ts
import { NotificationService } from "./gen/avm/bridge/v1/notification_pb.js";
```

Add to re-exports:
```ts
export { NotificationService } from "./gen/avm/bridge/v1/notification_pb.js";
export type {
  NotifyRequest,
  NotifyResponse,
} from "./gen/avm/bridge/v1/notification_pb.js";
export { NotificationKind } from "./gen/avm/bridge/v1/notification_pb.js";
```

Add the factory at the bottom:
```ts
export function createBridgeNotificationClient(port: number, token: string) {
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
    interceptors: [authInterceptor(token)],
  });
  return createClient(NotificationService, transport);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/bridge-client.ts
git commit -m "Export NotificationService client factory from shared

Mirrors the existing createBridgeEditorClient/createBridgeClient
pattern so the bridge CLI can construct an authenticated client
without re-implementing the transport plumbing."
```

---

## Task 3: Add the daemon notifications module

**Files:**
- Create: `packages/avm-daemon/src/notifications.ts`

- [ ] **Step 1: Create the module with the `dispatchNotification` function**

Create `packages/avm-daemon/src/notifications.ts` with this exact content:

```ts
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { ConnectError, Code } from "@connectrpc/connect";

import { NotificationKind } from "@avm/shared/gen/avm/bridge/v1/notification_pb";

const CONFIG_PATH = join(homedir(), ".avm", "config.yaml");

interface SoundConfig {
  file: string;
  volume: number;
}

const DEFAULT_SOUNDS: Record<"needs-attention" | "complete", SoundConfig> = {
  "needs-attention": {
    file: "/System/Library/Sounds/Ping.aiff",
    volume: 0.7,
  },
  complete: {
    file: "/System/Library/Sounds/Submarine.aiff",
    volume: 1.0,
  },
};

const MISSING_SOUND_LOGGED = new Set<string>();

interface NotificationsConfig {
  enabled: boolean;
  sounds: {
    "needs-attention": SoundConfig;
    complete: SoundConfig;
  };
}

/** Read the notifications block from `~/.avm/config.yaml`, applying defaults. */
function loadNotificationsConfig(): NotificationsConfig {
  const result: NotificationsConfig = {
    enabled: true,
    sounds: {
      "needs-attention": { ...DEFAULT_SOUNDS["needs-attention"] },
      complete: { ...DEFAULT_SOUNDS.complete },
    },
  };

  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    return result;
  }

  let parsed: unknown;
  try {
    parsed = parseDocument(raw).toJS();
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== "object") return result;

  const notifications = (parsed as Record<string, unknown>).notifications;
  if (!notifications || typeof notifications !== "object") return result;

  const obj = notifications as Record<string, unknown>;
  if (typeof obj.enabled === "boolean") result.enabled = obj.enabled;

  if (obj.sounds && typeof obj.sounds === "object") {
    const sounds = obj.sounds as Record<string, unknown>;
    for (const key of ["needs-attention", "complete"] as const) {
      const entry = sounds[key];
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.file === "string" && e.file.length > 0) {
        result.sounds[key].file = e.file;
      }
      if (typeof e.volume === "number" && e.volume >= 0 && e.volume <= 1) {
        result.sounds[key].volume = e.volume;
      }
    }
  }

  return result;
}

/** Format an in-container cwd as "<parent>/<dir>", mirroring the host hook script. */
function formatLocation(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  if (trimmed.length === 0 || trimmed === "/") return trimmed;
  const parts = trimmed.split("/");
  if (parts.length < 2) return trimmed;
  const dir = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  if (!parent || !dir) return trimmed;
  return `${parent}/${dir}`;
}

/** Resolve the kind enum to a string key into the sound map and message text. */
function kindMeta(kind: NotificationKind): { key: "needs-attention" | "complete"; body: string } {
  switch (kind) {
    case NotificationKind.NEEDS_ATTENTION:
      return { key: "needs-attention", body: "Claude needs your attention" };
    case NotificationKind.COMPLETE:
      return { key: "complete", body: "Claude completed its work" };
    default:
      throw new ConnectError(`Unknown notification kind: ${kind}`, Code.InvalidArgument);
  }
}

/** Escape a string for safe interpolation into AppleScript double-quoted strings. */
function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Dispatch a host-side notification. Plays a sound via afplay and posts a
 * macOS notification via osascript, both fire-and-forget. Returns
 * synchronously after spawning the children.
 *
 * On non-darwin hosts, this is a no-op (logged once at startup, see main.ts).
 *
 * Throws a ConnectError on unknown kind. The master switch is checked in
 * the route handler before this function is called.
 */
export function dispatchNotification(
  containerName: string,
  req: { kind: NotificationKind; cwd: string; sessionId: string },
): void {
  const { key, body } = kindMeta(req.kind);
  const config = loadNotificationsConfig();
  let sound = config.sounds[key];

  if (!existsSync(sound.file)) {
    const cacheKey = `${key}:${sound.file}`;
    if (!MISSING_SOUND_LOGGED.has(cacheKey)) {
      console.warn(
        `[notifications] sound file not found for ${key}: ${sound.file} — falling back to default`,
      );
      MISSING_SOUND_LOGGED.add(cacheKey);
    }
    sound = { ...DEFAULT_SOUNDS[key] };
  }

  const title = `AVM — ${containerName}`;
  let message = body;
  if (req.cwd && req.cwd.length > 0) {
    const location = formatLocation(req.cwd);
    if (location.length > 0) message = `${body}\n${location}`;
  }

  // afplay: detached, ignore output, never wait.
  const afplay = spawn("afplay", ["-v", String(sound.volume), sound.file], {
    detached: true,
    stdio: "ignore",
  });
  afplay.unref();
  afplay.on("error", (err) => {
    console.warn(`[notifications] afplay failed: ${err.message}`);
  });

  // osascript: same — detached, ignore output, never wait.
  const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`;
  const oa = spawn("osascript", ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  oa.unref();
  oa.on("error", (err) => {
    console.warn(`[notifications] osascript failed: ${err.message}`);
  });
}

/** True if the daemon should respond to Notify calls (master switch). */
export function notificationsEnabled(): boolean {
  return loadNotificationsConfig().enabled;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/avm-daemon/src/notifications.ts
git commit -m "Add daemon notifications module

Reads ~/.avm/config.yaml on every dispatch (cheap, no SIGHUP needed)
to honor the master switch and resolve sound files. Falls back to
defaults if config is absent or a configured sound file is missing,
and logs missing-file warnings at most once per (kind, file) per
daemon lifetime."
```

---

## Task 4: Wire the NotificationService route into the daemon

**Files:**
- Modify: `packages/avm-daemon/src/server.ts`
- Modify: `packages/avm-daemon/src/main.ts`

- [ ] **Step 1: Register the route in `createRoutes`**

Open `packages/avm-daemon/src/server.ts`. Add to the imports near the top:

```ts
import {
  NotificationService,
  NotifyResponseSchema,
} from "@avm/shared/gen/avm/bridge/v1/notification_pb";
import { dispatchNotification, notificationsEnabled } from "./notifications.js";
```

Inside the `createRoutes` function returned closure, after the existing
`router.service(BridgeEditorService, { ... })` block (around line 157) and
before the `router.service(HostServicesService, ...)` block, add:

```ts
    // Bridge notification API (called by containers from Claude hooks)
    router.service(NotificationService, {
      async notify(req, context) {
        const containerName = context.requestHeader.get("x-avm-container-name");
        if (!containerName) {
          throw new ConnectError("Container identity not resolved", Code.Internal);
        }
        // Master switch: silent no-op so Claude never sees an error.
        if (!notificationsEnabled()) {
          return create(NotifyResponseSchema, {});
        }
        if (process.platform !== "darwin") {
          return create(NotifyResponseSchema, {});
        }
        dispatchNotification(containerName, {
          kind: req.kind,
          cwd: req.cwd ?? "",
          sessionId: req.sessionId ?? "",
        });
        return create(NotifyResponseSchema, {});
      },
    });
```

- [ ] **Step 2: Add the platform-startup log in `main.ts`**

Open `packages/avm-daemon/src/main.ts`. Inside `main()`, after step 8
(writing the PID file), add a one-time log if the host is not darwin:

```ts
    if (process.platform !== "darwin") {
      console.log(
        `avm-daemon: notifications disabled — platform is ${process.platform}, only darwin is supported.`,
      );
    }
```

- [ ] **Step 3: Verify it builds**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/avm-daemon/src/server.ts packages/avm-daemon/src/main.ts
git commit -m "Wire NotificationService into the daemon Connect router

Mirrors the existing EditorService wiring: resolves container identity
from the auth-injected header, applies the master switch as a silent
no-op, and skips dispatch entirely on non-darwin hosts so the daemon
remains importable for future cross-platform work."
```

---

## Task 5: Add the bridge `claude-hook` subcommand

**Files:**
- Create: `packages/avm-bridge/src/cli/commands/claude-hook.ts`
- Modify: `packages/avm-bridge/src/cli/avm-bridge.ts`

- [ ] **Step 1: Create the command file**

Create `packages/avm-bridge/src/cli/commands/claude-hook.ts` with this
exact content:

```ts
import { defineCommand } from "citty";
import {
  createBridgeNotificationClient,
  NotificationKind,
} from "@avm/shared/bridge-client";
import { ConnectError } from "@connectrpc/connect";

function getClient() {
  const port = process.env.AVM_HOST_PORT;
  const token = process.env.AVM_HOST_TOKEN;

  if (!port) {
    console.error("AVM_HOST_PORT is not set. This command must run inside an avm container.");
    process.exit(0);
  }
  if (!token) {
    console.error("AVM_HOST_TOKEN is not set. This command must run inside an avm container.");
    process.exit(0);
  }

  return createBridgeNotificationClient(Number(port), token);
}

const EVENT_TO_KIND: Record<string, NotificationKind> = {
  notification: NotificationKind.NEEDS_ATTENTION,
  stop: NotificationKind.COMPLETE,
};

interface ClaudeHookPayload {
  cwd?: string;
  session_id?: string;
}

/** Read up to 64KB of stdin (best-effort), then JSON-parse. Never throws. */
async function readClaudeHookPayload(): Promise<ClaudeHookPayload> {
  if (process.stdin.isTTY) return {};

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > 64 * 1024) return {};
      chunks.push(buf);
    }
  } catch {
    return {};
  }

  if (chunks.length === 0) return {};
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    if (data && typeof data === "object") return data as ClaudeHookPayload;
  } catch {
    // Not JSON or malformed — treat as no payload.
  }
  return {};
}

export const claudeHookCommand = defineCommand({
  meta: {
    name: "claude-hook",
    description: "Adapter for Claude Code hook events — forwards to the host daemon.",
  },
  args: {
    event: {
      type: "positional",
      description: "Lowercased Claude hook event name (e.g. notification, stop).",
      required: true,
    },
  },
  async run({ args }) {
    const eventName = String(args.event).toLowerCase();
    const kind = EVENT_TO_KIND[eventName];
    if (kind === undefined) {
      console.error(`avm-bridge claude-hook: unknown event "${eventName}"`);
      process.exit(0);
    }

    const payload = await readClaudeHookPayload();

    const client = getClient();
    try {
      await client.notify({
        kind,
        cwd: payload.cwd ?? "",
        sessionId: payload.session_id ?? "",
      });
    } catch (err) {
      // Never block Claude. Log and exit 0.
      if (err instanceof ConnectError) {
        console.error(`avm-bridge claude-hook: ${err.message}`);
      } else {
        console.error(`avm-bridge claude-hook: ${err}`);
      }
    }
    process.exit(0);
  },
});
```

- [ ] **Step 2: Wire the command into the bridge entry**

Open `packages/avm-bridge/src/cli/avm-bridge.ts`. Add to the imports:

```ts
import { claudeHookCommand } from "./commands/claude-hook.ts";
```

Add to `subCommands`:

```ts
    "claude-hook": claudeHookCommand,
```

So the file ends up:

```ts
import { defineCommand, runMain } from "citty";
import { editorCommand } from "./commands/editor.ts";
import { serviceCommand } from "./commands/service.ts";
import { claudeHookCommand } from "./commands/claude-hook.ts";

const main = defineCommand({
  meta: {
    name: "avm-bridge",
    description: "avm bridge: coordinate with the host control plane.",
  },
  subCommands: {
    editor: editorCommand,
    service: serviceCommand,
    "claude-hook": claudeHookCommand,
  },
});

runMain(main);
```

- [ ] **Step 3: Verify it builds**

Run: `pnpm build`
Expected: build succeeds; the bridge bundle
`packages/avm-bridge/dist/avm-bridge.mjs` is regenerated.

- [ ] **Step 4: Manual smoke test (no daemon required)**

Run from the repo root:
```bash
echo '{"cwd": "/foo/bar/baz"}' | AVM_HOST_PORT=1 AVM_HOST_TOKEN=x \
  node packages/avm-bridge/dist/avm-bridge.mjs claude-hook notification
```
Expected: exits 0; stderr shows a connection error (because the daemon
isn't reachable on port 1) but the process never throws or exits non-zero.

Run again with a malformed event name:
```bash
echo '{}' | AVM_HOST_PORT=1 AVM_HOST_TOKEN=x \
  node packages/avm-bridge/dist/avm-bridge.mjs claude-hook bogus-event
```
Expected: exits 0; stderr says `avm-bridge claude-hook: unknown event "bogus-event"`.

- [ ] **Step 5: Commit**

```bash
git add packages/avm-bridge/src/cli/commands/claude-hook.ts packages/avm-bridge/src/cli/avm-bridge.ts
git commit -m "Add avm-bridge claude-hook subcommand

Reads up to 64KB of Claude hook JSON from stdin, extracts cwd and
session_id, maps the event name to a NotificationKind, and calls
NotificationService.Notify. Always exits 0 — hook failures must
never surface to Claude. Reserves avm-bridge notify for a future
generic notification API."
```

---

## Task 6: Add the `notifications.installPrompt` field to AvmState

**Files:**
- Modify: `packages/avm/src/lib/state.ts`

- [ ] **Step 1: Extend the AvmState type**

Open `packages/avm/src/lib/state.ts`. Modify the `AvmState` interface to
add the `notifications` field:

```ts
export interface AvmState {
  sshConfig?: {
    /** Set when the user has answered the first-run install prompt. */
    installPrompt?: "installed" | "declined";
  };
  notifications?: {
    /** Set when the user has answered the first-run install prompt. */
    installPrompt?: "installed" | "declined";
  };
}
```

The existing `updateState` already shallow-merges nested objects, so no
other change is needed.

- [ ] **Step 2: Verify it builds**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/avm/src/lib/state.ts
git commit -m "Add notifications.installPrompt to AvmState

Mirrors the existing sshConfig.installPrompt shape — tracks whether
the user has answered the first-run hook-install prompt, with the
same installed/declined vocabulary so a future prompt can be
re-enabled by clearing the field."
```

---

## Task 7: Extend the AvmConfig schema for `notifications`

**Files:**
- Modify: `packages/avm/src/lib/config-file.ts`

- [ ] **Step 1: Add the type**

Open `packages/avm/src/lib/config-file.ts`. Below the existing
`ServiceCheck` interface and above `AvmConfig`, add:

```ts
export interface NotificationSound {
  file: string;
  volume: number;
}

export interface NotificationsConfig {
  enabled: boolean;
  sounds: {
    "needs-attention": NotificationSound;
    complete: NotificationSound;
  };
}
```

Modify the `AvmConfig` interface to include `notifications`:

```ts
export interface AvmConfig {
  editor?: EditorChoice;
  daemon: DaemonConfig;
  volumes: VolumeMount[];
  repos: Record<string, RepoConfig>;
  services: Record<string, ServiceDefinition>;
  notifications: NotificationsConfig;
}
```

- [ ] **Step 2: Add the parser, defaults, and validator**

Add `"notifications"` to the `TOP_LEVEL_KEYS` set:

```ts
const TOP_LEVEL_KEYS = new Set(["editor", "volumes", "repos", "daemon", "services", "notifications"]);
```

Add the default-resolution constants near the top of the validator section
(below `VALID_SERVICE_KINDS`):

```ts
const NOTIFICATIONS_KEYS = new Set(["enabled", "sounds"]);
const SOUND_KEYS = new Set(["file", "volume"]);
const SOUND_NAMES = new Set(["needs-attention", "complete"]);

const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  enabled: true,
  sounds: {
    "needs-attention": {
      file: "/System/Library/Sounds/Ping.aiff",
      volume: 0.7,
    },
    complete: {
      file: "/System/Library/Sounds/Submarine.aiff",
      volume: 1.0,
    },
  },
};
```

In `loadAvmConfig`, update the empty-file return to include the defaults:

```ts
  if (!existsSync(avmConfigFile)) {
    return {
      daemon: { port: 6970 },
      volumes: [],
      repos: {},
      services: {},
      notifications: structuredClone(DEFAULT_NOTIFICATIONS),
    };
  }
```

In `validate`, parse the field and include it in the result:

```ts
  const editor = parseEditor(obj.editor);
  const daemon = parseDaemon(obj.daemon);
  const volumes = parseVolumes(obj.volumes);
  const repos = parseRepos(obj.repos);
  const services = parseServices(obj.services);
  const notifications = parseNotifications(obj.notifications);
  return { editor, daemon, volumes, repos, services, notifications };
```

Add the `parseNotifications` function at the bottom of the file, just
above `function describe`:

```ts
function parseNotifications(raw: unknown): NotificationsConfig {
  if (raw === undefined) return structuredClone(DEFAULT_NOTIFICATIONS);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "notifications" must be a mapping (got ${describe(raw)}).`,
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!NOTIFICATIONS_KEYS.has(key)) {
      throw new Error(
        `${avmConfigFile}: unknown key "${key}" under notifications. Allowed: ${[...NOTIFICATIONS_KEYS].join(", ")}.`,
      );
    }
  }

  const result = structuredClone(DEFAULT_NOTIFICATIONS);

  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new Error(
        `${avmConfigFile}: notifications.enabled must be a boolean (got ${describe(obj.enabled)}).`,
      );
    }
    result.enabled = obj.enabled;
  }

  if (obj.sounds !== undefined) {
    if (obj.sounds === null || typeof obj.sounds !== "object" || Array.isArray(obj.sounds)) {
      throw new Error(
        `${avmConfigFile}: notifications.sounds must be a mapping (got ${describe(obj.sounds)}).`,
      );
    }
    const sounds = obj.sounds as Record<string, unknown>;
    for (const key of Object.keys(sounds)) {
      if (!SOUND_NAMES.has(key)) {
        throw new Error(
          `${avmConfigFile}: unknown key "${key}" under notifications.sounds. Allowed: ${[...SOUND_NAMES].join(", ")}.`,
        );
      }
    }
    for (const name of SOUND_NAMES) {
      const entry = sounds[name];
      if (entry === undefined) continue;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `${avmConfigFile}: notifications.sounds.${name} must be a mapping (got ${describe(entry)}).`,
        );
      }
      const e = entry as Record<string, unknown>;
      for (const key of Object.keys(e)) {
        if (!SOUND_KEYS.has(key)) {
          throw new Error(
            `${avmConfigFile}: unknown key "${key}" under notifications.sounds.${name}. Allowed: ${[...SOUND_KEYS].join(", ")}.`,
          );
        }
      }
      const target = result.sounds[name as "needs-attention" | "complete"];
      if (e.file !== undefined) {
        if (typeof e.file !== "string" || e.file.length === 0) {
          throw new Error(
            `${avmConfigFile}: notifications.sounds.${name}.file must be a non-empty string (got ${describe(e.file)}).`,
          );
        }
        target.file = e.file;
      }
      if (e.volume !== undefined) {
        if (typeof e.volume !== "number" || !Number.isFinite(e.volume) || e.volume < 0 || e.volume > 1) {
          throw new Error(
            `${avmConfigFile}: notifications.sounds.${name}.volume must be a number 0–1 (got ${describe(e.volume)}).`,
          );
        }
        target.volume = e.volume;
      }
    }
  }

  return result;
}
```

- [ ] **Step 3: Add a setter for the daemon master switch**

Add this exported function to the same file, near `setConfigEditor`:

```ts
/**
 * Set the `notifications.enabled` field in `~/.avm/config.yaml`,
 * preserving all other content and formatting. Creates the file if
 * it doesn't exist.
 */
export function setNotificationsEnabled(enabled: boolean): void {
  const raw = existsSync(avmConfigFile)
    ? readFileSync(avmConfigFile, "utf-8")
    : "";
  const doc = parseDocument(raw);
  doc.setIn(["notifications", "enabled"], enabled);
  writeFileSync(avmConfigFile, doc.toString());
}
```

- [ ] **Step 4: Verify it builds**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/avm/src/lib/config-file.ts
git commit -m "Add notifications config schema to AvmConfig

Adds enabled (master switch) and sounds (per-kind file + volume)
under a new top-level notifications block, with defaults applied
when the field is absent. Adds setNotificationsEnabled for the
mute/unmute commands to toggle the master switch in place without
touching unrelated config."
```

---

## Task 8: Add the pure hook-installer module

**Files:**
- Create: `packages/avm/src/lib/notify-hooks.ts`

- [ ] **Step 1: Create the module**

Create `packages/avm/src/lib/notify-hooks.ts` with this exact content:

```ts
/**
 * Pure logic for installing/uninstalling AVM notification hooks in
 * Claude Code's `~/.claude/settings.json` (mounted from
 * `~/.avm/system/claude/settings.json` on the host).
 *
 * "AVM entries" are identified by command-prefix matching: any entry
 * whose every hooks[].command starts with `avm-bridge claude-hook ` is
 * considered AVM-managed. This is the only convention; no JSON marker
 * fields are used.
 */

export const AVM_HOOK_COMMAND_PREFIX = "avm-bridge claude-hook ";

export interface ClaudeHookCommand {
  type: string;
  command: string;
}

export interface ClaudeHookEntry {
  matcher?: string;
  hooks?: ClaudeHookCommand[];
}

export interface ClaudeSettings {
  hooks?: {
    Notification?: ClaudeHookEntry[];
    Stop?: ClaudeHookEntry[];
    [key: string]: ClaudeHookEntry[] | undefined;
  };
  [key: string]: unknown;
}

const AVM_NOTIFICATION_ENTRY: ClaudeHookEntry = {
  matcher: "*",
  hooks: [{ type: "command", command: "avm-bridge claude-hook notification" }],
};

const AVM_STOP_ENTRY: ClaudeHookEntry = {
  matcher: "*",
  hooks: [{ type: "command", command: "avm-bridge claude-hook stop" }],
};

function isAvmEntry(entry: ClaudeHookEntry): boolean {
  if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) return false;
  return entry.hooks.every(
    (h) => typeof h.command === "string" && h.command.startsWith(AVM_HOOK_COMMAND_PREFIX),
  );
}

function stripAvmEntries(entries: ClaudeHookEntry[] | undefined): ClaudeHookEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => !isAvmEntry(e));
}

/** Returns a new settings object with AVM hook entries removed and the canonical AVM entries appended. */
export function installHooks(settings: ClaudeSettings): ClaudeSettings {
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = next.hooks!;

  const notification = stripAvmEntries(hooks.Notification);
  notification.push(structuredClone(AVM_NOTIFICATION_ENTRY));
  hooks.Notification = notification;

  const stop = stripAvmEntries(hooks.Stop);
  stop.push(structuredClone(AVM_STOP_ENTRY));
  hooks.Stop = stop;

  return next;
}

/** Returns a new settings object with AVM hook entries removed (no re-add). */
export function uninstallHooks(settings: ClaudeSettings): ClaudeSettings {
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = next.hooks!;

  if (Array.isArray(hooks.Notification)) {
    const filtered = stripAvmEntries(hooks.Notification);
    if (filtered.length === 0) delete hooks.Notification;
    else hooks.Notification = filtered;
  }
  if (Array.isArray(hooks.Stop)) {
    const filtered = stripAvmEntries(hooks.Stop);
    if (filtered.length === 0) delete hooks.Stop;
    else hooks.Stop = filtered;
  }

  // If hooks ended up empty, drop it.
  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  }

  return next;
}

/** Count installed AVM entries across both arrays — used by `avm notify status`. */
export function countAvmEntries(settings: ClaudeSettings): number {
  let n = 0;
  for (const arr of [settings.hooks?.Notification, settings.hooks?.Stop]) {
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) if (isAvmEntry(entry)) n++;
  }
  return n;
}
```

- [ ] **Step 2: Verify it builds**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/avm/src/lib/notify-hooks.ts
git commit -m "Add pure module for editing Claude settings.json hooks

Pure functions: installHooks, uninstallHooks, countAvmEntries. Edits
only Notification and Stop arrays; identifies AVM entries by command-
prefix match (avm-bridge claude-hook ); never touches unrelated keys
or entries; returns new objects instead of mutating input so the
caller controls IO."
```

---

## Task 9: Add the `avm notify` command group

**Files:**
- Create: `packages/avm/src/cli/commands/notify.ts`
- Modify: `packages/avm/src/cli/avm.ts`

- [ ] **Step 1: Create the command file**

Create `packages/avm/src/cli/commands/notify.ts` with this exact content:

```ts
import { defineCommand } from "citty";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { confirm, isCancel, log } from "@clack/prompts";

import { avmSystemClaudeDir } from "../../lib/config.ts";
import { loadAvmConfig, setNotificationsEnabled } from "../../lib/config-file.ts";
import { readState, updateState } from "../../lib/state.ts";
import {
  installHooks,
  uninstallHooks,
  countAvmEntries,
  type ClaudeSettings,
} from "../../lib/notify-hooks.ts";

const SETTINGS_PATH = join(avmSystemClaudeDir, "settings.json");

function loadSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  const raw = readFileSync(SETTINGS_PATH, "utf-8");
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ClaudeSettings;
    return {};
  } catch (err) {
    throw new Error(
      `Could not parse ${SETTINGS_PATH} as JSON: ${(err as Error).message}\n` +
        `Refusing to overwrite. Fix the file by hand and re-run.`,
    );
  }
}

function writeSettings(settings: ClaudeSettings): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

const installSub = defineCommand({
  meta: {
    name: "install",
    description: "Install host-notification hooks into the in-container Claude settings.",
  },
  async run() {
    const settings = loadSettings();
    const next = installHooks(settings);
    writeSettings(next);
    updateState({ notifications: { installPrompt: "installed" } });
    console.log(`Installed avm notification hooks in ${SETTINGS_PATH}.`);
    console.log("Open the avm container and run `claude` — Notification and Stop will ping the host.");
  },
});

const uninstallSub = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove host-notification hooks from the in-container Claude settings.",
  },
  async run() {
    const settings = loadSettings();
    const before = countAvmEntries(settings);
    const next = uninstallHooks(settings);
    writeSettings(next);
    // Clear the prompt decision so a future `provision`/`start` re-asks.
    updateState({ notifications: { installPrompt: undefined } });
    if (before === 0) {
      console.log(`No avm hook entries found in ${SETTINGS_PATH}. Nothing to uninstall.`);
    } else {
      console.log(`Removed ${before} avm hook entr${before === 1 ? "y" : "ies"} from ${SETTINGS_PATH}.`);
    }
  },
});

const muteSub = defineCommand({
  meta: {
    name: "mute",
    description: "Disable host notifications without uninstalling hooks.",
  },
  async run() {
    setNotificationsEnabled(false);
    console.log("Notifications muted (notifications.enabled: false in ~/.avm/config.yaml).");
  },
});

const unmuteSub = defineCommand({
  meta: {
    name: "unmute",
    description: "Re-enable host notifications.",
  },
  async run() {
    setNotificationsEnabled(true);
    console.log("Notifications unmuted (notifications.enabled: true in ~/.avm/config.yaml).");
  },
});

function printStatus(): void {
  let settings: ClaudeSettings;
  let parseError: string | null = null;
  try {
    settings = loadSettings();
  } catch (err) {
    settings = {};
    parseError = (err as Error).message;
  }
  const installed = countAvmEntries(settings);

  let config;
  try {
    config = loadAvmConfig();
  } catch (err) {
    console.log(`Could not load ~/.avm/config.yaml: ${(err as Error).message}`);
    return;
  }

  const state = readState();
  const promptState = state.notifications?.installPrompt ?? "(not asked)";

  console.log(`Hook install:    ${installed > 0 ? `installed (${installed} entr${installed === 1 ? "y" : "ies"})` : "not installed"}`);
  if (parseError) console.log(`                 ${parseError}`);
  console.log(`Settings file:   ${SETTINGS_PATH}`);
  console.log(`Master switch:   notifications.enabled = ${config.notifications.enabled}`);
  console.log(`Sound — needs-attention: ${config.notifications.sounds["needs-attention"].file} @ ${config.notifications.sounds["needs-attention"].volume}`);
  console.log(`Sound — complete:        ${config.notifications.sounds.complete.file} @ ${config.notifications.sounds.complete.volume}`);
  console.log(`Install prompt:  ${promptState}`);
}

const statusSub = defineCommand({
  meta: {
    name: "status",
    description: "Show notification install state, mute state, and sound config.",
  },
  async run() {
    printStatus();
  },
});

/**
 * Run the first-run install prompt. No-op if the user has already answered
 * (state.notifications.installPrompt is set). Returns true if the prompt
 * was shown, false otherwise.
 */
export async function maybePromptForInstall(): Promise<boolean> {
  const state = readState();
  if (state.notifications?.installPrompt !== undefined) return false;

  const answer = await confirm({
    message:
      "AVM can play a sound and post a macOS notification when the agent needs your attention or finishes a turn. Install hooks now?\nYou can change this later with `avm notify {install,uninstall,mute,unmute}`.",
    initialValue: true,
  });

  if (isCancel(answer)) {
    // Treat cancel as "ask again next time" — don't record an answer.
    log.warn("Install prompt cancelled. AVM will ask again next time.");
    return true;
  }

  if (answer === true) {
    const settings = loadSettings();
    const next = installHooks(settings);
    writeSettings(next);
    updateState({ notifications: { installPrompt: "installed" } });
    log.success(`Installed avm notification hooks in ${SETTINGS_PATH}.`);
  } else {
    updateState({ notifications: { installPrompt: "declined" } });
    log.info("Skipped — you can install later with `avm notify install`.");
  }
  return true;
}

export const notifyCommand = defineCommand({
  meta: {
    name: "notify",
    description: "Manage host-notification hooks for in-container Claude Code.",
  },
  subCommands: {
    install: installSub,
    uninstall: uninstallSub,
    status: statusSub,
    mute: muteSub,
    unmute: unmuteSub,
  },
  async run() {
    // Default: status.
    printStatus();
  },
});
```

- [ ] **Step 2: Wire the command into the host CLI**

Open `packages/avm/src/cli/avm.ts`. Add to the imports:

```ts
import { notifyCommand } from "./commands/notify.ts";
```

Add to `subCommands`:

```ts
    notify: notifyCommand,
```

- [ ] **Step 3: Verify it builds**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 4: Manual smoke test**

```bash
# Status before any changes — should show "not installed".
node packages/avm/dist/avm.mjs notify status

# Install (writes ~/.avm/system/claude/settings.json).
node packages/avm/dist/avm.mjs notify install

# Status now — should show installed (2 entries) and prompt: installed.
node packages/avm/dist/avm.mjs notify status

# Show the resulting settings.json.
cat ~/.avm/system/claude/settings.json

# Mute / unmute toggles config.yaml (not settings.json).
node packages/avm/dist/avm.mjs notify mute
grep -A2 notifications ~/.avm/config.yaml
node packages/avm/dist/avm.mjs notify unmute
grep -A2 notifications ~/.avm/config.yaml

# Uninstall — should remove entries and clear the prompt.
node packages/avm/dist/avm.mjs notify uninstall
node packages/avm/dist/avm.mjs notify status
```

Expected:
- `install` writes a settings.json with `Notification` and `Stop` arrays
  containing one entry each (command `avm-bridge claude-hook ...`).
- `status` reflects the install/mute state correctly.
- `mute`/`unmute` updates `notifications.enabled` in config.yaml without
  touching settings.json.
- `uninstall` removes the entries and resets `installPrompt` so a fresh
  `notify status` shows `(not asked)`.

If the user already had pre-existing hooks under `Notification` or `Stop`,
verify they are preserved across install/uninstall by adding a custom
entry by hand and re-running.

- [ ] **Step 5: Commit**

```bash
git add packages/avm/src/cli/commands/notify.ts packages/avm/src/cli/avm.ts
git commit -m "Add avm notify command group

Subcommands: install (idempotent), uninstall, status, mute, unmute.
The install logic round-trips ~/.avm/system/claude/settings.json
through the pure notify-hooks module so unrelated keys and other
hooks are preserved verbatim; refuses to overwrite if the file is
malformed JSON. Mute/unmute only touches config.yaml — orthogonal
to install state — and a future first-run prompt is exported as
maybePromptForInstall for provision/start to call."
```

---

## Task 10: Wire the first-run prompt into `avm provision`

**Files:**
- Modify: `packages/avm/src/cli/commands/provision.ts`

- [ ] **Step 1: Call `maybePromptForInstall` after image build**

Open `packages/avm/src/cli/commands/provision.ts`. Update the file to:

```ts
import { defineCommand } from "citty";
import { provisionImages } from "../../lib/image.ts";
import { maybePromptForInstall } from "./notify.ts";

export const provisionCommand = defineCommand({
  meta: {
    name: "provision",
    description:
      "Build the avm-core and user Docker images for agent containers.",
  },
  async run() {
    const tag = await provisionImages();

    console.log();
    console.log(`Done. Images built — avm:${tag} / avm:latest.`);
    console.log(`Start an agent session: avm create --attach`);
    console.log();

    // First-run prompt for host notifications. No-op if already answered.
    await maybePromptForInstall();
  },
});
```

- [ ] **Step 2: Verify it builds**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/avm/src/cli/commands/provision.ts
git commit -m "Fire the notify-install prompt at the end of avm provision

provision is the natural setup hook — every user runs it, and asking
once after a successful image build is unobtrusive. The prompt is
gated on state.notifications.installPrompt and so only fires once."
```

---

## Task 11: Wire the first-run prompt into `avm start`

**Files:**
- Modify: `packages/avm/src/cli/commands/start.ts`

- [ ] **Step 1: Call `maybePromptForInstall` after host scaffolding**

Open `packages/avm/src/cli/commands/start.ts`. Add to the imports:

```ts
import { maybePromptForInstall } from "./notify.ts";
```

After `ensureHostScaffolding();` (around line 70) and before the
`loadAvmConfig` block, add:

```ts
    await maybePromptForInstall();
```

- [ ] **Step 2: Verify it builds**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/avm/src/cli/commands/start.ts
git commit -m "Fire the notify-install prompt as a fallback in avm start

Ensures users who never re-run provision still get asked exactly
once. Gated on state.notifications.installPrompt so it skips
silently after the first answer."
```

---

## Task 12: Document the notifications config in examples/config.yaml

**Files:**
- Modify: `examples/config.yaml`

- [ ] **Step 1: Append a commented-out notifications block**

Open `examples/config.yaml`. Append at the end of the file:

```yaml

# Host notifications — sound + macOS notification when in-container Claude
# fires a Notification or Stop hook. Defaults shown below; uncomment to
# customise.
#
# notifications:
#   enabled: true
#   sounds:
#     needs-attention:
#       file: /System/Library/Sounds/Ping.aiff
#       volume: 0.7
#     complete:
#       file: /System/Library/Sounds/Submarine.aiff
#       volume: 1.0
```

- [ ] **Step 2: Commit**

```bash
git add examples/config.yaml
git commit -m "Document notifications config in examples/config.yaml

Defaults are baked into the daemon and config validator, so the
block is purely informational — users only need to uncomment if
they want to customise sounds or mute via config.yaml."
```

---

## Task 13: End-to-end manual verification

This task isn't a code change — it's the verification that the system
works end to end, per project convention ("Manual end-to-end testing").

- [ ] **Step 1: Restart the daemon to pick up the new code**

```bash
node packages/avm/dist/avm.mjs daemon stop
node packages/avm/dist/avm.mjs daemon start
```

Expected: daemon starts cleanly; check `~/.avm/daemon/daemon.log` for the
"avm-daemon listening on 127.0.0.1:6970" line.

- [ ] **Step 2: Ensure hooks are installed**

```bash
node packages/avm/dist/avm.mjs notify install
node packages/avm/dist/avm.mjs notify status
```

Expected: status shows `installed (2 entries)` and the master switch
`notifications.enabled = true`.

- [ ] **Step 3: Start (or create) an avm container and attach**

```bash
node packages/avm/dist/avm.mjs create --attach
# or, if a container exists: node packages/avm/dist/avm.mjs start <id> --attach
```

Inside the container, verify the bridge binary is present and the env
vars are set:

```bash
which avm-bridge
echo "$AVM_HOST_PORT $AVM_HOST_TOKEN"
```

Expected: bridge resolves to `/usr/local/bin/avm-bridge`; both env vars
are non-empty.

- [ ] **Step 4: Smoke-test the bridge command directly**

Inside the container:

```bash
echo '{"cwd": "/home/agent/work/test-repo/feature-x"}' | \
  avm-bridge claude-hook notification
echo '{"cwd": "/home/agent/work/test-repo/feature-x"}' | \
  avm-bridge claude-hook stop
```

Expected: each command exits 0; on the host you see and hear a macOS
notification reading respectively:
- Title `AVM — <container-name>`, body `Claude needs your attention\ntest-repo/feature-x`, Ping sound at 0.7.
- Title `AVM — <container-name>`, body `Claude completed its work\ntest-repo/feature-x`, Submarine sound at 1.0.

- [ ] **Step 5: Smoke-test mute and master switch**

On the host:

```bash
node packages/avm/dist/avm.mjs notify mute
```

Inside the container, repeat the bridge calls. Expected: no sound, no
notification (silent no-op). Bridge still exits 0.

```bash
node packages/avm/dist/avm.mjs notify unmute
```

Repeat the bridge calls. Expected: notifications resume.

- [ ] **Step 6: Smoke-test the in-container Claude flow**

Inside the container:

```bash
claude
```

Trigger a turn that completes (e.g., ask Claude a trivial question that
returns immediately). On the host, expect a `complete` notification.

If you have an `AskUserQuestion`-using flow handy, trigger one and expect
a `needs-attention` notification.

- [ ] **Step 7: Smoke-test settings.json non-destructive uninstall**

Edit `~/.avm/system/claude/settings.json` to add a custom entry under
`Notification`, e.g.:

```json
{
  "matcher": "*",
  "hooks": [{ "type": "command", "command": "echo custom" }]
}
```

Run `node packages/avm/dist/avm.mjs notify uninstall`.

Inspect the file. Expected: AVM entries removed, the custom entry
preserved verbatim.

Run `node packages/avm/dist/avm.mjs notify install`.

Inspect the file again. Expected: AVM entries re-added; custom entry
still preserved.

- [ ] **Step 8: Commit nothing**

This task creates no code changes. If issues are found, return to the
relevant earlier task and fix the implementation, then re-run this
verification task.

---

## Self-review notes

- **Spec coverage:** all spec sections (proto, bridge command, daemon
  handler, host CLI, hook installer, config schema, state tracking,
  first-run prompt, edge cases) have a corresponding task.
- **Type consistency:** `NotificationKind` enum, `ClaudeSettings`/
  `ClaudeHookEntry` types, `NotificationsConfig`, `installHooks`/
  `uninstallHooks`/`countAvmEntries`, and `maybePromptForInstall` are
  consistently named across tasks.
- **Project conventions:** no automated tests added; verification is
  manual end-to-end (Task 13). All scripting via TypeScript (no bash).
- **Idempotence:** install and uninstall both round-trip through the
  pure module so re-running is safe.
- **Decoupling:** daemon never knows about Claude; bridge owns the
  Claude-event-to-NotificationKind mapping; settings.json holds only
  pass-through invocations.
