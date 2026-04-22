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
