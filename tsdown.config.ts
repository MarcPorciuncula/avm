import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "avm": "packages/avm/src/cli/avm.ts",
    "avm-bridge": "packages/avm-bridge/src/cli/avm-bridge.ts",
    "avm-daemon": "packages/avm-daemon/src/main.ts",
  },
  format: "esm",
  platform: "node",
  deps: { neverBundle: [/^(?!@avm\/)[^./]/] },
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
});
