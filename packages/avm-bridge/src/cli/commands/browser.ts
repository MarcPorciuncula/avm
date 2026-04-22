import { defineCommand } from "citty";
import { createBridgeBrowserClient } from "@avm/shared/bridge-client";
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

  return createBridgeBrowserClient(Number(port), token);
}

const openCommand = defineCommand({
  meta: {
    name: "open",
    description: "Open a URL in the user's default browser on the host.",
  },
  args: {
    url: {
      type: "positional",
      description: "URL to open (http or https)",
      required: true,
    },
  },
  async run({ args }) {
    const client = getClient();
    try {
      const res = await client.openUrl({ url: args.url });
      console.log(`opened ${res.url}`);
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

export const browserCommand = defineCommand({
  meta: {
    name: "browser",
    description: "Open URLs in the user's default host browser.",
  },
  subCommands: {
    open: openCommand,
  },
});
