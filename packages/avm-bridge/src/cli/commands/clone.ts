import { defineCommand } from "citty";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createBridgeReposClient } from "@avm/shared/bridge-client";
import { ConnectError } from "@connectrpc/connect";

function getReposClient() {
  const port = process.env.AVM_HOST_PORT;
  const token = process.env.AVM_HOST_TOKEN;
  if (!port || !token) {
    console.error("AVM_HOST_PORT/AVM_HOST_TOKEN unset. This command must run inside an avm container.");
    process.exit(1);
  }
  return createBridgeReposClient(Number(port), token);
}

function readMirrorOriginUrl(mirrorPath: string): string {
  const out = execFileSync("git", ["-C", mirrorPath, "remote", "get-url", "origin"], {
    encoding: "utf-8",
  });
  return out.trim();
}

export const cloneCommand = defineCommand({
  meta: {
    name: "clone",
    description:
      "Clone a repo into ~/work/<name>, using the host mirror at ~/mirrors/<name>.git when present.",
  },
  args: {
    name: {
      type: "positional",
      description: "Repo name. Used for the mirror lookup and the working-copy directory.",
      required: true,
    },
    url: {
      type: "string",
      description: "Override remote URL. Required if no mirror exists for <name>.",
    },
    "no-link": {
      type: "boolean",
      description: "Skip the post-clone `avm-bridge link` step.",
    },
  },
  async run({ args }) {
    const home = homedir();
    const mirrorPath = join(home, "mirrors", `${args.name}.git`);
    const targetDir = join(home, "work", args.name);

    if (existsSync(targetDir)) {
      console.error(
        `Error: ${targetDir} already exists. cd into it and run \`avm-bridge link\` instead.`,
      );
      process.exit(1);
    }

    const hasMirror = existsSync(mirrorPath);
    let url = args.url;
    if (!url) {
      if (!hasMirror) {
        console.error(
          `Error: no mirror at ${mirrorPath} and no --url provided. ` +
            `Pass --url <git-url> or ask the user to add a mirror at ~/.avm/mirrors/${args.name}.git on the host.`,
        );
        process.exit(1);
      }
      try {
        url = readMirrorOriginUrl(mirrorPath);
      } catch (err) {
        console.error(`Error: failed to read origin URL from ${mirrorPath}: ${err}`);
        process.exit(1);
      }
    }

    const gitArgs = ["clone"];
    if (hasMirror) {
      gitArgs.push("--reference", mirrorPath);
    }
    gitArgs.push(url, targetDir);

    console.log(`==> git ${gitArgs.join(" ")}`);
    const cloneRes = spawnSync("git", gitArgs, { stdio: "inherit" });
    if (cloneRes.status !== 0) {
      process.exit(cloneRes.status ?? 1);
    }

    if (args["no-link"]) {
      return;
    }

    const client = getReposClient();
    let repo;
    try {
      repo = await client.getRepo({ name: args.name });
    } catch (err) {
      if (err instanceof ConnectError) {
        console.error(`Warning: link skipped — ${err.message}`);
      } else {
        console.error(`Warning: link skipped — ${err}`);
      }
      return;
    }
    if (repo.symlinks.length === 0) {
      return;
    }

    const filesRoot = join(home, ".avm-files");
    for (const link of repo.symlinks) {
      const src = join(filesRoot, link.source);
      const target = isAbsolute(link.target) ? link.target : resolve(targetDir, link.target);
      const parent = dirname(target);
      if (parent !== "." && parent !== "/") mkdirSync(parent, { recursive: true });
      try {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink() || stat.isFile()) unlinkSync(target);
      } catch {
        // Target doesn't exist — fine.
      }
      symlinkSync(src, target);
      console.log(`linked ${link.target} -> ${src}`);
    }
  },
});
