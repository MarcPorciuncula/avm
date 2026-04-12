import { defineCommand } from "citty";
import Table from "tty-table";
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

    const EPHEMERAL_START = 32768;
    const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
    const fmtPorts = (ports: number[]) => {
      if (ports.length === 0) return "";
      return ports
        .map((p) => (p >= EPHEMERAL_START ? dim(String(p)) : String(p)))
        .join(", ");
    };

    const statusStrings = vms.map((v) =>
      v.outdated ? `${v.status} (outdated)` : v.status,
    );
    const portsStrings = vms.map((v) => fmtPorts(v.ports));

    const gap = 2;
    const idW = Math.max(2, ...vms.map((v) => v.id.length));
    const nameW = Math.max(4, ...vms.map((v) => v.name.length));
    const statusW = Math.max(6, ...statusStrings.map((s) => s.length));
    const fixedTotal = (idW + gap) + (nameW + gap) + (statusW + gap);
    const portsW = Math.max(5, (process.stdout.columns || 80) - fixedTotal);

    const col = (value: string, width: number) => ({
      value,
      headerAlign: "left" as const,
      align: "left" as const,
      fixed: true,
      width: width + gap,
      paddingLeft: 0,
      paddingRight: gap,
    });

    const header = [
      col("ID", idW),
      col("NAME", nameW),
      col("STATUS", statusW),
      { ...col("PORTS", portsW), paddingRight: 0, width: portsW },
    ];

    const rows = vms.map((vm, i) => [
      vm.id,
      vm.name,
      statusStrings[i]!,
      portsStrings[i]!,
    ]);

    const t = Table(header, rows, {
      borderStyle: "none",
      paddingLeft: 0,
      paddingRight: 0,
      marginLeft: 0,
      marginTop: 0,
    });
    console.log(t.render());
  },
});
