import { defineCommand } from "citty";
import { select, isCancel, cancel } from "@clack/prompts";
import { spawnSync } from "node:child_process";
import {
  type EditorChoice,
  loadAvmConfig,
  setConfigEditor,
} from "../../lib/config-file.ts";
import { listAvmVms, resolveVmByPrefix } from "../../lib/vm.ts";

const EDITORS: { value: EditorChoice; label: string; cli: string }[] = [
  { value: "cursor", label: "Cursor", cli: "cursor" },
  { value: "code", label: "VS Code", cli: "code" },
];

function editorIsAvailable(cli: string): boolean {
  const result = spawnSync("which", [cli], { stdio: "ignore" });
  return result.status === 0;
}

function resolveEditor(config: ReturnType<typeof loadAvmConfig>): {
  cli: string;
  choice: EditorChoice;
} | null {
  if (config.editor) {
    const entry = EDITORS.find((e) => e.value === config.editor);
    if (entry && editorIsAvailable(entry.cli)) {
      return { cli: entry.cli, choice: entry.value };
    }
    if (entry) {
      console.error(
        `Error: "${entry.cli}" is not installed or not in PATH.`,
      );
      return null;
    }
  }
  return null;
}

export const editorCommand = defineCommand({
  meta: {
    name: "editor",
    description: "Open a container in your editor (VS Code / Cursor).",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description: "Short ID of the container to open.",
    },
  },
  async run({ args }) {
    const vms = await listAvmVms();
    let vmName: string;

    if (args.id) {
      try {
        vmName = resolveVmByPrefix(args.id, vms).vm.name;
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      if (vms.length === 0) {
        console.log("No agent containers. Run `avm create` first.");
        return;
      }
      const running = vms.filter((v) => v.status === "running");
      if (running.length === 0) {
        console.log("No running containers. Start one first.");
        return;
      }
      if (running.length === 1) {
        vmName = running[0]!.name;
      } else {
        const picked = await select({
          message: "Select a container to open",
          options: running.map((vm) => ({
            value: vm.name,
            label: `${vm.id} (${vm.status})`,
          })),
        });
        if (isCancel(picked)) {
          cancel("Aborted.");
          process.exit(0);
        }
        vmName = picked as string;
      }
    }

    let config;
    try {
      config = loadAvmConfig();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }

    let editor = resolveEditor(config);

    if (!editor) {
      // Auto-detect available editors
      const available = EDITORS.filter((e) => editorIsAvailable(e.cli));

      if (available.length === 0) {
        console.error(
          "Error: No supported editor found. Install VS Code (`code`) or Cursor (`cursor`).",
        );
        process.exit(1);
      }

      if (available.length === 1) {
        editor = { cli: available[0]!.cli, choice: available[0]!.value };
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
          process.exit(0);
        }
        editor = {
          choice: picked as EditorChoice,
          cli: available.find((e) => e.value === picked)!.cli,
        };
      }

      // Persist the choice
      setConfigEditor(editor.choice);
      console.log(`Saved editor preference: ${editor.choice}`);
    }

    // Build the remote URI
    const hexName = Buffer.from(vmName).toString("hex");
    const uri = `vscode-remote://attached-container+${hexName}/home/agent/work`;

    console.log(`==> Opening ${vmName} in ${editor.choice}...`);
    spawnSync(editor.cli, ["--folder-uri", uri], { stdio: "inherit" });
  },
});
