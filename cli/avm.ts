import { defineCommand, runMain } from "citty";
import { listCommand } from "./commands/list.tsx";
import { createCommand } from "./commands/create.ts";
import { startCommand } from "./commands/start.ts";
import { stopCommand } from "./commands/stop.ts";
import { cleanCommand } from "./commands/clean.ts";
import { attachCommand } from "./commands/attach.ts";
import { editorCommand } from "./commands/editor.ts";
import { execCommand } from "./commands/exec.ts";
import { provisionCommand } from "./commands/provision.ts";

const main = defineCommand({
  meta: {
    name: "avm",
    description: "Manage agent containers.",
  },
  subCommands: {
    list: listCommand,
    create: createCommand,
    start: startCommand,
    attach: attachCommand,
    editor: editorCommand,
    exec: execCommand,
    stop: stopCommand,
    clean: cleanCommand,
    provision: provisionCommand,
  },
});

runMain(main);
