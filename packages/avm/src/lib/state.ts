import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { avmStateFile } from "./config.ts";

export interface AvmState {
  sshConfig?: {
    /** Set when the user has answered the first-run install prompt. */
    installPrompt?: "installed" | "declined";
  };
  notifications?: {
    /** Set when the user has answered the first-run install prompt. */
    installPrompt?: "installed" | "declined";
  };
}

/** Read `~/.avm/state.json`. Returns `{}` if missing or malformed. */
export function readState(): AvmState {
  try {
    const raw = readFileSync(avmStateFile, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge `partial` into the current state and persist. Shallow-merges each
 * top-level key, so callers can update one subsection without clobbering
 * unrelated state.
 */
export function updateState(partial: AvmState): AvmState {
  const current = readState();
  const next: AvmState = { ...current };
  for (const [key, value] of Object.entries(partial)) {
    const k = key as keyof AvmState;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      next[k] = { ...(current[k] ?? {}), ...value } as AvmState[typeof k];
    } else {
      next[k] = value as AvmState[typeof k];
    }
  }
  mkdirSync(dirname(avmStateFile), { recursive: true });
  const tmp = `${avmStateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, avmStateFile);
  return next;
}
