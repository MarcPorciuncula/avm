import { $ } from "zx";
import { randomBytes } from "node:crypto";

export interface VmInfo {
  /** Short ID — the suffix after `avm-`. */
  id: string;
  /** Full VM name, e.g. `avm-k7xf2`. */
  name: string;
  /** OrbStack state: "running" | "stopped" | other. */
  status: string;
}

interface OrbListEntry {
  name: string;
  state: string;
}

/** Pipe `cmd` to `bash -l` running as root on the given VM. */
export async function asRoot(vmName: string, cmd: string): Promise<void> {
  await $({ input: cmd })`ssh root@${vmName}@orb bash -l`;
}

/** Pipe `cmd` to `bash -l` running as the default agent user on the given VM. */
export async function asAgent(vmName: string, cmd: string): Promise<void> {
  await $({ input: cmd })`ssh ${vmName}@orb bash -l`;
}

/** Poll SSH connectivity. Throws if SSH doesn't come up within `timeoutSeconds`. */
export async function waitForSsh(
  vmName: string,
  timeoutSeconds = 30,
): Promise<void> {
  for (let i = 0; i < timeoutSeconds; i++) {
    const result = await $({
      input: "echo ok",
    })`ssh -o ConnectTimeout=1 root@${vmName}@orb bash -l`
      .quiet()
      .nothrow();
    if (result.exitCode === 0) return;
    await $`sleep 1`;
  }
  throw new Error(`SSH not available on ${vmName} after ${timeoutSeconds}s`);
}

/** Generate a random 5-char lowercase alphanumeric suffix and return `avm-<suffix>`. */
export function generateSessionName(): string {
  const suffix = randomBytes(8).toString("hex").slice(0, 5);
  return `avm-${suffix}`;
}

/**
 * Normalize a user-provided name: strip any leading `avm-`, then prepend `avm-`.
 * Ensures the result always starts with exactly one `avm-`.
 */
export function normalizeVmName(name: string): string {
  const stripped = name.startsWith("avm-") ? name.slice(4) : name;
  return `avm-${stripped}`;
}

/** List VMs whose names start with `avm-`. Uses `orb list -f json`. */
export async function listAvmVms(): Promise<VmInfo[]> {
  const result = await $`orb list -f json`.quiet();
  const entries = JSON.parse(result.stdout) as OrbListEntry[];
  return entries
    .filter((entry) => entry.name.startsWith("avm-"))
    .map((entry) => ({
      id: entry.name.slice(4),
      name: entry.name,
      status: entry.state,
    }));
}

export interface PrefixResolution {
  vm: VmInfo;
  /** True if the input was a prefix of the matched ID rather than an exact match. */
  isPartial: boolean;
}

/**
 * Resolve a user-provided ID (or prefix) to a single VM.
 *
 * Strips any leading `avm-` from the input, then:
 * - Returns an exact match if one exists (`isPartial: false`).
 * - Otherwise, returns the unique prefix match (`isPartial: true`).
 * - Throws if zero or multiple prefix matches exist.
 */
export function resolveVmByPrefix(
  input: string,
  vms: VmInfo[],
): PrefixResolution {
  const needle = input.startsWith("avm-") ? input.slice(4) : input;

  const exact = vms.find((vm) => vm.id === needle);
  if (exact) {
    return { vm: exact, isPartial: false };
  }

  const matches = vms.filter((vm) => vm.id.startsWith(needle));
  if (matches.length === 0) {
    throw new Error(`No VM matching "${input}".`);
  }
  if (matches.length > 1) {
    const list = matches.map((vm) => `  - ${vm.id}`).join("\n");
    throw new Error(
      `"${input}" is ambiguous. Matches:\n${list}\nUse a longer prefix.`,
    );
  }
  return { vm: matches[0]!, isPartial: true };
}
