import { defineCommand, runMain } from "citty";
import { listCommand } from "./commands/list.ts";
import { createCommand } from "./commands/create.ts";
import { startCommand } from "./commands/start.ts";
import { stopCommand } from "./commands/stop.ts";
import { cleanCommand } from "./commands/clean.ts";
import { attachCommand } from "./commands/attach.ts";
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
    stop: stopCommand,
    clean: cleanCommand,
    provision: provisionCommand,
  },
});

runMain(main);
