import { path } from "zx";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const AVM_LABEL = "avm=true";
export const CORE_IMAGE = "avm-core";
export const USER_IMAGE = "avm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

// --- ~/.avm/ layout ---

export const AVM_HOME = path.join(os.homedir(), ".avm");

export const avmSystemDir = path.join(AVM_HOME, "system");
export const avmSystemSshDir = path.join(avmSystemDir, "credentials/ssh");
export const avmSystemGitConfigFile = path.join(
  avmSystemDir,
  "credentials/git/.gitconfig",
);
export const avmSystemClaudeDir = path.join(avmSystemDir, "claude");
export const avmSystemClaudeJsonFile = path.join(avmSystemDir, "claude.json");

export const avmMirrorsDir = path.join(AVM_HOME, "mirrors");
export const avmVolumesDir = path.join(AVM_HOME, "volumes");
export const avmFilesDir = path.join(AVM_HOME, "files");

export const avmConfigFile = path.join(AVM_HOME, "config.yaml");
