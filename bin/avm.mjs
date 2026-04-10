#!/usr/bin/env node
// Thin wrapper so `avm` can be installed globally via `pnpm link --global`.
// Invokes the local tsx binary on cli/avm.ts with the repo root as cwd.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");
const cliPath = resolve(repoRoot, "cli/avm.ts");

const result = spawnSync(tsxBin, [cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: repoRoot,
});

process.exit(result.status ?? 0);
