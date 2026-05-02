import { spawnSync } from "node:child_process";
import { select, isCancel, cancel } from "@clack/prompts";
import {
  type AvmConfig,
  type EditorChoice,
  setConfigEditor,
} from "./config-file.ts";

const EDITORS: { value: EditorChoice; label: string; cli: string }[] = [
  { value: "cursor", label: "Cursor", cli: "cursor" },
  { value: "code", label: "VS Code", cli: "code" },
  { value: "zed", label: "Zed", cli: "zed" },
];

function editorIsAvailable(cli: string): boolean {
  const result = spawnSync("which", [cli], { stdio: "ignore" });
  return result.status === 0;
}

/**
 * Resolve the editor CLI to use. Checks config, auto-detects, prompts
 * if multiple are available, and persists the choice. Returns null if
 * no editor is available.
 */
export async function resolveEditorCli(
  config: AvmConfig,
): Promise<string | null> {
  if (config.editor) {
    const entry = EDITORS.find((e) => e.value === config.editor);
    if (entry && editorIsAvailable(entry.cli)) {
      return entry.cli;
    }
    if (entry) {
      console.error(`Error: "${entry.cli}" is not installed or not in PATH.`);
      return null;
    }
  }

  const available = EDITORS.filter((e) => editorIsAvailable(e.cli));

  if (available.length === 0) {
    console.error(
      "Error: No supported editor found. Install VS Code (`code`) or Cursor (`cursor`).",
    );
    return null;
  }

  let choice: EditorChoice;
  if (available.length === 1) {
    choice = available[0]!.value;
  } else {
    const picked = await select({
      message: "Which editor do you want to use?",
      options: available.map((e) => ({
        value: e.value,
        label: e.label,
      })),
    });
    if (isCancel(picked)) {
      cancel("Aborted.");
      return null;
    }
    choice = picked as EditorChoice;
  }

  setConfigEditor(choice);
  console.log(`Saved editor preference: ${choice}`);
  return available.find((e) => e.value === choice)!.cli;
}

/**
 * Open a container in the user's editor. Dispatches to a per-brand
 * argv builder: code/cursor use the Dev Containers attached-container
 * URI; zed uses an SSH URI (requires `avm ssh-config install`).
 */
export function openInEditor(cli: string, vmName: string): void {
  const argv = buildWorkspaceArgv(cli, vmName);
  console.log(`==> Opening ${vmName} in ${cli}...`);
  spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" });
}

function buildWorkspaceArgv(cli: string, vmName: string): string[] {
  if (cli === "zed") {
    return ["zed", `ssh://${vmName}/home/agent/work`];
  }
  // code / cursor: Dev Containers attached-container URI
  const hexName = Buffer.from(vmName).toString("hex");
  const uri = `vscode-remote://attached-container+${hexName}/home/agent/work`;
  return [cli, "--folder-uri", uri];
}
