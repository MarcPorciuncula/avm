import { defineCommand, runMain } from "citty";
import { serviceCommand } from "./commands/service.ts";

const main = defineCommand({
  meta: {
    name: "avm-bridge",
    description: "avm bridge: coordinate with the host control plane.",
  },
  subCommands: {
    service: serviceCommand,
  },
});

runMain(main);
