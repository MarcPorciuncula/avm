import { defineCommand } from "citty";
import { listAvmVms } from "../../lib/vm.ts";

export const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List agent containers.",
  },
  async run() {
    const vms = await listAvmVms();
    if (vms.length === 0) {
      console.log("No agent containers.");
      return;
    }

    const idHeader = "ID";
    const nameHeader = "NAME";
    const statusHeader = "STATUS";
    const idWidth = Math.max(idHeader.length, ...vms.map((v) => v.id.length));
    const nameWidth = Math.max(
      nameHeader.length,
      ...vms.map((v) => v.name.length),
    );
    const statusWidth = Math.max(
      statusHeader.length,
      ...vms.map((v) => v.status.length),
    );

    const pad = (s: string, w: number) => s.padEnd(w);
    console.log(
      `${pad(idHeader, idWidth)}  ${pad(nameHeader, nameWidth)}  ${pad(statusHeader, statusWidth)}`,
    );
    for (const vm of vms) {
      console.log(
        `${pad(vm.id, idWidth)}  ${pad(vm.name, nameWidth)}  ${pad(vm.status, statusWidth)}`,
      );
    }
  },
});
