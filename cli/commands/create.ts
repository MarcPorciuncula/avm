import { defineCommand } from "citty";
import { $ } from "zx";
import { loadAvmConfig } from "../../lib/config-file.ts";
import { USER_IMAGE, AVM_LABEL, getHostTimezone } from "../../lib/config.ts";
import { openInEditor, resolveEditorCli } from "../../lib/editor.ts";
import {
  applyPostCreationSetup,
  ensureHostScaffolding,
  getDockerMountArgs,
} from "../../lib/session.ts";
import {
  attachToVm,
  generateSessionName,
  listAvmVms,
  normalizeVmName,
  shortIdOf,
} from "../../lib/vm.ts";

export const createCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create and start a new agent container.",
  },
  args: {
    name: {
      type: "positional",
      required: false,
      description:
        "Suffix for the container name (avm- is prepended automatically). Random if omitted.",
    },
    attach: {
      type: "boolean",
      description: "After setup, attach to the container.",
    },
    editor: {
      type: "boolean",
      description: "After setup, open the container in your editor.",
    },
  },
  async run({ args }) {
    const vmName = args.name
      ? normalizeVmName(args.name)
      : generateSessionName();

    const existing = await listAvmVms();
    if (existing.some((v) => v.name === vmName)) {
      console.error(
        `Error: Container ${vmName} already exists. ` +
          `Use 'avm start ${shortIdOf(vmName)}' to resume it, or ` +
          `'avm clean ${shortIdOf(vmName)}' to delete and recreate.`,
      );
      process.exit(1);
    }

    ensureHostScaffolding();

    let config;
    try {
      config = loadAvmConfig();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }

    const mountArgs = getDockerMountArgs(config);

    const tz = getHostTimezone();
    const tzArgs = tz ? ["-e", `TZ=${tz}`] : [];

    console.log(`==> Creating container ${vmName}...`);
    await $`docker run -d ${[
      "--name", vmName,
      "--hostname", vmName,
      "--label", AVM_LABEL,
      "--network", "host",
      "--privileged",
      "--init",
      "-v", `${vmName}-docker:/var/lib/docker`,
      "-e", `AVM_ID=${shortIdOf(vmName)}`,
      ...tzArgs,
      ...mountArgs,
    ]} ${`${USER_IMAGE}:latest`} sleep infinity`;

    await applyPostCreationSetup(vmName, config);

    console.log();
    console.log("Session ready.");
    console.log();
    console.log(`  Attach: avm attach ${shortIdOf(vmName)}`);
    console.log();

    if (args.editor) {
      const cli = await resolveEditorCli(config);
      if (cli) openInEditor(cli, vmName);
    }

    if (args.attach) {
      console.log(`==> Attaching to ${vmName}...`);
      process.exit(attachToVm(vmName));
    }
  },
});
