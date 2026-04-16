import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConnectError, Code } from "@connectrpc/connect";
import { parseDocument } from "yaml";

const CONFIG_PATH = join(homedir(), ".avm", "config.yaml");

/**
 * Open a file in the user's editor via SSH remote.
 * Resolves the editor from the request or config, validates prerequisites,
 * spawns the editor detached, and returns metadata about what was launched.
 */
export function openFile(
  containerName: string,
  req: { path: string; line: number; column: number; editor: string },
): { editor: string; sshHost: string; command: string } {
  // 1. Resolve editor name.
  let editorName = req.editor;
  if (!editorName) {
    try {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const doc = parseDocument(raw);
      const parsed = doc.toJS() as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object" && typeof parsed.editor === "string") {
        editorName = parsed.editor;
      }
    } catch {
      // Config file missing or unreadable — fall through.
    }
  }
  if (!editorName) {
    throw new ConnectError(
      "No editor configured. Set the 'editor' field in ~/.avm/config.yaml or pass it in the request.",
      Code.FailedPrecondition,
    );
  }

  // 2. Validate supported editors.
  if (editorName !== "cursor" && editorName !== "code") {
    throw new ConnectError(
      `Unsupported editor: ${editorName}. Only "cursor" and "code" are supported.`,
      Code.InvalidArgument,
    );
  }

  // 3. Validate editor binary is on PATH.
  const whichResult = spawnSync("which", [editorName]);
  if (whichResult.status !== 0) {
    throw new ConnectError(
      `Editor binary "${editorName}" not found on PATH. Is it installed?`,
      Code.FailedPrecondition,
    );
  }

  // 4. Validate SSH config for the container.
  const sshResult = spawnSync("ssh", ["-G", containerName]);
  if (sshResult.status !== 0) {
    throw new ConnectError(
      "avm SSH config is not installed. The user needs to run `avm ssh-config install` on the host.",
      Code.FailedPrecondition,
    );
  }

  // 5. Build argv.
  const argv = [
    "--remote",
    `ssh-remote+${containerName}`,
    req.path,
  ];
  if (req.line > 0) {
    let gotoTarget = `${req.path}:${req.line}`;
    if (req.column > 0) {
      gotoTarget += `:${req.column}`;
    }
    argv.push("--goto", gotoTarget);
  }

  // 6. Spawn detached.
  const child = spawn(editorName, argv, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // 7. Return metadata.
  return {
    editor: editorName,
    sshHost: containerName,
    command: [editorName, ...argv].join(" "),
  };
}
