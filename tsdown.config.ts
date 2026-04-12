import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["cli/avm.ts"],
  format: "esm",
  platform: "node",
  deps: { neverBundle: [/^[^./]/] },
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
});
