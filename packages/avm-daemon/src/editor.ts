import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConnectError, Code } from "@connectrpc/connect";
import { parseDocument } from "yaml";

const CONFIG_PATH = join(homedir(), ".avm", "config.yaml");

export type OpenFileMode = "attached-container" | "ssh-remote";

/**
 * Default transport used by `openFile`. The attached-container path skips
 * the SSH dependency entirely and is preferred for editor-launch from the
 * bridge. The ssh-remote path is preserved for cases where attaching to a
 * local Docker socket isn't viable.
 */
const DEFAULT_MODE: OpenFileMode = "attached-container";

/**
 * Open a file in the user's editor on the host. Resolves the editor from
 * the request or config, validates prerequisites for the chosen mode,
 * spawns the editor detached, and returns metadata about what was
 * launched.
 */
export function openFile(
  containerName: string,
  req: { path: string; line: number; column: number; editor: string },
  mode: OpenFileMode = DEFAULT_MODE,
): { editor: string; remoteAuthority: string; command: string } {
  const editorName = resolveEditor(req.editor);
  validateEditorBinary(editorName);

  const remoteAuthority = mode === "ssh-remote"
    ? buildSshRemoteAuthority(containerName)
    : buildAttachedContainerAuthority(containerName);

  const argv = ["--remote", remoteAuthority, req.path];
  if (req.line > 0) {
    let gotoTarget = `${req.path}:${req.line}`;
    if (req.column > 0) {
      gotoTarget += `:${req.column}`;
    }
    argv.push("--goto", gotoTarget);
  }

  const child = spawn(editorName, argv, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return {
    editor: editorName,
    remoteAuthority,
    command: [editorName, ...argv].join(" "),
  };
}

function resolveEditor(requested: string): string {
  let editorName = requested;
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
  if (editorName !== "cursor" && editorName !== "code") {
    throw new ConnectError(
      `Unsupported editor: ${editorName}. Only "cursor" and "code" are supported.`,
      Code.InvalidArgument,
    );
  }
  return editorName;
}

function validateEditorBinary(editorName: string): void {
  const whichResult = spawnSync("which", [editorName]);
  if (whichResult.status !== 0) {
    throw new ConnectError(
      `Editor binary "${editorName}" not found on PATH. Is it installed?`,
      Code.FailedPrecondition,
    );
  }
}

function buildAttachedContainerAuthority(containerName: string): string {
  return `attached-container+${Buffer.from(containerName).toString("hex")}`;
}

function buildSshRemoteAuthority(containerName: string): string {
  const sshResult = spawnSync("ssh", ["-G", containerName]);
  if (sshResult.status !== 0) {
    throw new ConnectError(
      "avm SSH config is not installed. The user needs to run `avm ssh-config install` on the host.",
      Code.FailedPrecondition,
    );
  }
  return `ssh-remote+${containerName}`;
}
