import { build } from "esbuild";
import { chmodSync } from "node:fs";

// Bundle the CLI into a single executable ESM file. npm deps are kept
// external so Node resolves them from node_modules at runtime — this keeps
// the output file small and avoids issues with packages that rely on their
// own file layout (like zx spawning subprocesses).

await build({
  entryPoints: ["cli/avm.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
  outfile: "dist/avm.mjs",
});

chmodSync("dist/avm.mjs", 0o755);
console.log("Built dist/avm.mjs");
