import React from "react";
import { render, Box, Text } from "ink";
import { defineCommand } from "citty";
import { listAvmVms, type VmInfo } from "../../lib/vm.ts";

function VmTable({ vms }: { vms: VmInfo[] }) {
  const statusStrings = vms.map((v) =>
    v.outdated ? `${v.status} (outdated)` : v.status,
  );
  const col = {
    id: Math.max(2, ...vms.map((v) => v.id.length)),
    name: Math.max(4, ...vms.map((v) => v.name.length)),
    status: Math.max(6, ...statusStrings.map((s) => s.length)),
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={col.id} flexShrink={0} marginRight={2}>
          <Text bold>ID</Text>
        </Box>
        <Box width={col.name} flexShrink={0} marginRight={2}>
          <Text bold>NAME</Text>
        </Box>
        <Box width={col.status} flexShrink={0} marginRight={2}>
          <Text bold>STATUS</Text>
        </Box>
      </Box>
      {vms.map((vm, i) => (
        <Box key={vm.name}>
          <Box width={col.id} flexShrink={0} marginRight={2}>
            <Text>{vm.id}</Text>
          </Box>
          <Box width={col.name} flexShrink={0} marginRight={2}>
            <Text>{vm.name}</Text>
          </Box>
          <Box width={col.status} flexShrink={0} marginRight={2}>
            <Text>{statusStrings[i]}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

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

    const { unmount } = render(<VmTable vms={vms} />);
    unmount();
  },
});
