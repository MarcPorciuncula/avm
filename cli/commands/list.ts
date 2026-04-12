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
    const portsHeader = "PORTS";

    const fmtPorts = (ports: number[]) =>
      ports.length > 0 ? ports.join(", ") : "";
    const portsStrings = vms.map((v) => fmtPorts(v.ports));
    const statusStrings = vms.map((v) =>
      v.outdated ? `${v.status} (outdated)` : v.status,
    );

    const idWidth = Math.max(idHeader.length, ...vms.map((v) => v.id.length));
    const nameWidth = Math.max(
      nameHeader.length,
      ...vms.map((v) => v.name.length),
    );
    const statusWidth = Math.max(
      statusHeader.length,
      ...statusStrings.map((s) => s.length),
    );
    const portsWidth = Math.max(portsHeader.length, ...portsStrings.map((s) => s.length));

    const pad = (s: string, w: number) => s.padEnd(w);
    console.log(
      `${pad(idHeader, idWidth)}  ${pad(nameHeader, nameWidth)}  ${pad(statusHeader, statusWidth)}  ${pad(portsHeader, portsWidth)}`,
    );
    for (let i = 0; i < vms.length; i++) {
      const vm = vms[i]!;
      console.log(
        `${pad(vm.id, idWidth)}  ${pad(vm.name, nameWidth)}  ${pad(statusStrings[i]!, statusWidth)}  ${pad(portsStrings[i]!, portsWidth)}`,
      );
    }
  },
});
