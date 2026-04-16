import { defineConfig } from "tsdown";

export default defineConfig([
  // Host-side: CLI + daemon share chunks (both run from dist/ on the host)
  {
    entry: {
      "avm": "packages/avm/src/cli/avm.ts",
      "avm-daemon": "packages/avm-daemon/src/main.ts",
    },
    format: "esm",
    platform: "node",
    deps: { neverBundle: [/^(?!@avm\/)[^./]/] },
    outDir: "dist",
    banner: { js: "#!/usr/bin/env node" },
  },
  // Bridge: must be a single self-contained file (bind-mounted into containers)
  {
    entry: {
      "avm-bridge": "packages/avm-bridge/src/cli/avm-bridge.ts",
    },
    format: "esm",
    platform: "node",
    deps: { neverBundle: [/^(?!@avm\/)[^./]/] },
    outDir: "dist",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
