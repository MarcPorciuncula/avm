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

    const EPHEMERAL_START = 32768;
    const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
    const fmtPorts = (ports: number[]) => {
      if (ports.length === 0) return "";
      return ports.map((p) => (p >= EPHEMERAL_START ? dim(String(p)) : String(p))).join(", ");
    };
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
    const pad = (s: string, w: number) => s.padEnd(w);
    console.log(
      `${pad(idHeader, idWidth)}  ${pad(nameHeader, nameWidth)}  ${pad(statusHeader, statusWidth)}  ${portsHeader}`,
    );
    for (let i = 0; i < vms.length; i++) {
      const vm = vms[i]!;
      console.log(
        `${pad(vm.id, idWidth)}  ${pad(vm.name, nameWidth)}  ${pad(statusStrings[i]!, statusWidth)}  ${portsStrings[i]!}`,
      );
    }
  },
});
