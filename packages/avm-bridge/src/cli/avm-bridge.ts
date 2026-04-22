import { defineCommand, runMain } from "citty";
import { browserCommand } from "./commands/browser.ts";
import { editorCommand } from "./commands/editor.ts";
import { serviceCommand } from "./commands/service.ts";
import { claudeHookCommand } from "./commands/claude-hook.ts";

const main = defineCommand({
  meta: {
    name: "avm-bridge",
    description: "avm bridge: coordinate with the host control plane.",
  },
  subCommands: {
    browser: browserCommand,
    editor: editorCommand,
    service: serviceCommand,
    "claude-hook": claudeHookCommand,
  },
});

runMain(main);
