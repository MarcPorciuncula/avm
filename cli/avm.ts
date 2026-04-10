#!/usr/bin/env pnpm exec tsx

import { defineCommand, runMain } from "citty";
import { listCommand } from "./commands/list.ts";
import { startCommand } from "./commands/start.ts";
import { stopCommand } from "./commands/stop.ts";
import { cleanCommand } from "./commands/clean.ts";
import { attachCommand } from "./commands/attach.ts";
import { provisionCommand } from "./commands/provision.ts";

const main = defineCommand({
  meta: {
    name: "avm",
    description: "Manage alcova agent VMs.",
  },
  subCommands: {
    list: listCommand,
    start: startCommand,
    attach: attachCommand,
    stop: stopCommand,
    clean: cleanCommand,
    provision: provisionCommand,
  },
});

runMain(main);
