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
