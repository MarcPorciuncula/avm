import { $, path } from "zx";
import { existsSync } from "node:fs";
import { GITHUB_ORG, mirrorsDir } from "./config.ts";

/** Ensure a bare mirror exists and is up to date. Creates it if missing. */
export async function ensureMirror(repo: string): Promise<void> {
  const mirrorPath = path.join(mirrorsDir, `${repo}.git`);
  if (existsSync(mirrorPath)) {
    console.log(`==> Updating mirror: ${repo}...`);
    await $`git -C ${mirrorPath} fetch --all --prune`;
  } else {
    console.log(`==> Creating mirror: ${repo}...`);
    await $`git clone --bare git@github.com:${GITHUB_ORG}/${repo}.git ${mirrorPath}`;
  }
}

/** Ensure mirrors for all given repos exist and are fresh. */
export async function updateMirrors(repos: string[]): Promise<void> {
  for (const repo of repos) {
    await ensureMirror(repo);
  }
}
