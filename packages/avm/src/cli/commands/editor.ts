import { defineCommand } from "citty";
import { select, isCancel, cancel } from "@clack/prompts";
import { loadAvmConfig } from "../../lib/config-file.ts";
import { ensureDaemonRunning } from "../../lib/daemon.ts";
import { openInEditor, resolveEditorCli } from "../../lib/editor.ts";
import { listAvmVms, resolveVmByPrefix } from "../../lib/vm.ts";

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

    const cli = await resolveEditorCli(config);
    if (!cli) process.exit(1);

    try {
      await ensureDaemonRunning();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }

    openInEditor(cli, vmName);
  },
});
