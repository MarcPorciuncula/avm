import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["packages/avm/src/cli/avm.ts", "packages/avm-daemon/src/main.ts"],
  format: "esm",
  platform: "node",
  deps: { neverBundle: [/^(?!@avm\/)[^./]/] },
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
});
