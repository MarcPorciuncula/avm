import { defineCommand } from "citty";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { createBridgeReposClient } from "@avm/shared/bridge-client";
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

  return createBridgeReposClient(Number(port), token);
}

export const linkCommand = defineCommand({
  meta: {
    name: "link",
    description:
      "Apply per-repo symlinks declared in ~/.avm/config.yaml to the current working copy.",
  },
  args: {
    repo: {
      type: "positional",
      description: "Repo name (defaults to basename of cwd).",
      required: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd();
    const repoName = args.repo ?? basename(cwd);

    const client = getClient();
    let repo;
    try {
      repo = await client.getRepo({ name: repoName });
    } catch (err) {
      if (err instanceof ConnectError) {
        console.error(err.message);
      } else {
        console.error(`Error: ${err}`);
      }
      process.exit(1);
    }

    if (repo.symlinks.length === 0) {
      return;
    }

    const filesRoot = join(homedir(), ".avm-files");
    for (const link of repo.symlinks) {
      const src = join(filesRoot, link.source);
      const target = isAbsolute(link.target) ? link.target : resolve(cwd, link.target);
      const parent = dirname(target);
      if (parent !== "." && parent !== "/") {
        mkdirSync(parent, { recursive: true });
      }
      try {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink() || stat.isFile()) {
          unlinkSync(target);
        }
      } catch {
        // Target doesn't exist — fine.
      }
      symlinkSync(src, target);
      console.log(`linked ${link.target} -> ${src}`);
    }
  },
});
