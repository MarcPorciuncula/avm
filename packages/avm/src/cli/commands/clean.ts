import { defineCommand } from "citty";
import { $ } from "zx";
import { confirm, isCancel, cancel } from "@clack/prompts";
import { listAvmVms, resolveVmArg, resolveVmByPrefix, type VmInfo } from "../../lib/vm.ts";
import { syncSshConfig } from "../../lib/ssh-config.ts";
import { unregisterContainer } from "../../lib/session.ts";

export const cleanCommand = defineCommand({
  meta: {
    name: "clean",
    description: "Stop and delete one or more agent containers.",
  },
  args: {
    all: {
      type: "boolean",
      description: "Clean every avm container.",
    },
    "all-outdated": {
      type: "boolean",
      description: "Clean every outdated avm container.",
    },
  },
  async run({ args }) {
    const rawIds = ((args as { _?: string[] })._ ?? []).filter(
      (s) => s.length > 0,
    );
    const vms = await listAvmVms();

    interface Target {
      name: string;
      status: string;
      /** True when resolved from a prefix (requires confirmation). */
      needsConfirm: boolean;
    }

    let targets: Target[];
    if (args.all) {
      targets = vms.map((v) => ({
        name: v.name,
        status: v.status,
        needsConfirm: false,
      }));
      if (targets.length === 0) {
        console.log("No agent containers to clean.");
        return;
      }
    } else if (args["all-outdated"]) {
      targets = vms
        .filter((v) => v.outdated)
        .map((v) => ({
          name: v.name,
          status: v.status,
          needsConfirm: false,
        }));
      if (targets.length === 0) {
        console.log("No outdated containers to clean.");
        return;
      }
    } else {
      targets = [];
      if (rawIds.length === 0) {
        try {
          const vm = resolveVmArg(undefined, vms);
          targets.push({ name: vm.name, status: vm.status, needsConfirm: false });
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        for (const id of rawIds) {
          try {
            const { vm, isPartial } = resolveVmByPrefix(id, vms);
            targets.push({
              name: vm.name,
              status: vm.status,
              needsConfirm: isPartial,
            });
          } catch (err) {
            console.error(`Error: ${(err as Error).message}`);
            process.exit(1);
          }
        }
      }
    }

    for (const target of targets) {
      if (target.needsConfirm) {
        const ok = await confirm({
          message: `Delete ${target.name}?`,
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          cancel(`Skipped ${target.name}.`);
          continue;
        }
      }

      if (target.status === "running") {
        const ok = await confirm({
          message: `${target.name} is still running. Stop and delete it?`,
          initialValue: false,
        });
        if (isCancel(ok) || !ok) {
          cancel(`Skipped ${target.name}.`);
          continue;
        }
      }

      await unregisterContainer(target.name);
      console.log(`==> Stopping ${target.name}...`);
      await $`docker stop ${target.name}`.nothrow();
      console.log(`==> Deleting ${target.name}...`);
      await $`docker rm -f ${target.name}`;
      await $`docker volume rm ${target.name}-docker`.nothrow();
    }

    await syncSshConfig();
  },
});
