import { defineCommand, runMain } from "citty";
import { listCommand } from "./commands/list.tsx";
import { createCommand } from "./commands/create.ts";
import { startCommand } from "./commands/start.ts";
import { stopCommand } from "./commands/stop.ts";
import { cleanCommand } from "./commands/clean.ts";
import { attachCommand } from "./commands/attach.ts";
import { editorCommand } from "./commands/editor.ts";
import { execCommand } from "./commands/exec.ts";
import { sshCommand } from "./commands/ssh.ts";
import { sshConfigCommand } from "./commands/ssh-config.ts";
import { notifyCommand } from "./commands/notify.ts";
import { provisionCommand } from "./commands/provision.ts";
import { daemonCommand } from "./commands/daemon.ts";
import { serviceCommand } from "./commands/service.ts";

const main = defineCommand({
  meta: {
    name: "avm",
    description: "Manage agent containers.",
  },
  subCommands: {
    list: listCommand,
    ls: listCommand,
    create: createCommand,
    start: startCommand,
    attach: attachCommand,
    editor: editorCommand,
    exec: execCommand,
    ssh: sshCommand,
    "ssh-config": sshConfigCommand,
    notify: notifyCommand,
    stop: stopCommand,
    clean: cleanCommand,
    destroy: cleanCommand,
    provision: provisionCommand,
    daemon: daemonCommand,
    service: serviceCommand,
  },
});

runMain(main);
