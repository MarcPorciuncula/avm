import { defineCommand } from "citty";
import { resolve } from "node:path";
import { createBridgeEditorClient } from "@avm/shared/bridge-client";
import { ConnectError } from "@connectrpc/connect";

function getClient() {
  const port = process.env.AVM_HOST_PORT;
  const token = process.env.AVM_HOST_TOKEN;

  if (!port) {
    console.error("AVM_HOST_PORT is not set. This command must run inside an avm container.");
    process.exit(1);
  }
  if (!token) {
    console.error("AVM_HOST_TOKEN is not set. This command must run inside an avm container.");
    process.exit(1);
  }

  return createBridgeEditorClient(Number(port), token);
}

const openCommand = defineCommand({
  meta: {
    name: "open",
    description: "Open a file in the user's editor on the host.",
  },
  args: {
    path: {
      type: "positional",
      description: "File path to open",
      required: true,
    },
    line: {
      type: "string",
      description: "Line number (1-based)",
    },
    column: {
      type: "string",
      description: "Column number (1-based)",
    },
    editor: {
      type: "string",
      description: "Editor to use (cursor, code, or zed)",
    },
  },
  async run({ args }) {
    const client = getClient();
    const filePath = resolve(args.path);

    try {
      const res = await client.openFile({
        path: filePath,
        line: args.line ? parseInt(args.line, 10) : 0,
        column: args.column ? parseInt(args.column, 10) : 0,
        editor: args.editor ?? "",
      });
      console.log(`opened ${res.editor} on ${res.remoteAuthority}`);
    } catch (err) {
      if (err instanceof ConnectError) {
        console.error(err.message);
      } else {
        console.error(`Error: ${err}`);
      }
      process.exit(1);
    }
  },
});

export const editorCommand = defineCommand({
  meta: {
    name: "editor",
    description: "Open files in the user's host editor.",
  },
  subCommands: {
    open: openCommand,
  },
});
