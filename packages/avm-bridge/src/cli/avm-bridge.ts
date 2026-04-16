import { defineCommand, runMain } from "citty";
import { editorCommand } from "./commands/editor.ts";
import { serviceCommand } from "./commands/service.ts";

const main = defineCommand({
  meta: {
    name: "avm-bridge",
    description: "avm bridge: coordinate with the host control plane.",
  },
  subCommands: {
    editor: editorCommand,
    service: serviceCommand,
  },
});

runMain(main);
