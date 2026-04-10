import { path } from "zx";
import { fileURLToPath } from "node:url";

export const BASE_VM_NAME = "avm-base";
/** Legacy base VM name, removed during provisioning if encountered. */
export const LEGACY_BASE_VM_NAME = "alcova-base";
export const GITHUB_ORG = "Alcova-AI";

// Repos to clone into the VM. Key is the primary repo; value is its dependency repos.
export const REPO_DEPS: Record<string, string[]> = {
  "operator-ui": ["alcova-backend"],
};

export const ALL_REPOS: string[] = Array.from(
  new Set(
    Object.entries(REPO_DEPS).flatMap(([primary, deps]) => [primary, ...deps]),
  ),
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const templatesDir = path.join(REPO_ROOT, "templates");
export const dataDir = path.join(REPO_ROOT, "data");
export const mirrorsDir = path.join(dataDir, "mirrors");
export const credentialsDir = path.join(dataDir, "credentials");
export const envsDir = path.join(dataDir, "envs");
export const cacheDir = path.join(dataDir, "cache");
export const claudeDir = path.join(dataDir, "claude");
/** Sibling file to `claudeDir` — Claude Code's `~/.claude.json` settings file. */
export const claudeJsonFile = path.join(dataDir, "claude.json");

/** VM-side absolute path that reaches the alcova-vm repo on the host (before lockdown). */
export const vmHostPrefix = `/mnt/mac${REPO_ROOT}`;
