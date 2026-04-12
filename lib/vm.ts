import { $ } from "zx";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { AVM_LABEL } from "./config.ts";

export interface VmInfo {
  /** Short ID — the suffix after `avm-`. */
  id: string;
  /** Full container name, e.g. `avm-k7xf2`. */
  name: string;
  /** Container state: "running" | "stopped" | other. */
  status: string;
  /** Listening TCP ports (only populated for running containers). */
  ports: number[];
  /** True if the container's image no longer matches `avm:latest`. */
  outdated: boolean;
}

interface DockerPsEntry {
  Names: string;
  State: string;
}

/** Pipe `cmd` to `bash -l` running as root in the given container. */
export async function asRoot(vmName: string, cmd: string): Promise<void> {
  await $({ input: cmd })`docker exec -i -u root ${vmName} bash -l`;
}

/** Pipe `cmd` to `bash -l` running as the agent user in the given container. */
export async function asAgent(vmName: string, cmd: string): Promise<void> {
  await $({ input: cmd })`docker exec -i -u agent ${vmName} bash -l`;
}

/** Attach an interactive shell to the given container. Returns the exit code. */
export function attachToVm(vmName: string): number {
  const result = spawnSync(
    "docker",
    ["exec", "-it", "-w", "/home/agent/work", vmName, "bash", "-l"],
    { stdio: "inherit" },
  );
  return result.status ?? 1;
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

/**
 * Strip the leading `avm-` prefix from a full container name to get its short
 * user-facing id. Returns the input unchanged if it doesn't have the
 * prefix. Inverse of `normalizeVmName`.
 */
export function shortIdOf(vmName: string): string {
  return vmName.startsWith("avm-") ? vmName.slice(4) : vmName;
}

/**
 * Get TCP ports a running container is listening on.
 * Reads /proc/net/tcp and /proc/net/tcp6 inside the container — state 0A is LISTEN.
 * Returns an empty array for non-running containers or on any error.
 */
async function getListeningPorts(containerName: string): Promise<number[]> {
  try {
    const result =
      await $`docker exec ${containerName} cat /proc/net/tcp /proc/net/tcp6`.quiet();
    const ports = new Set<number>();
    for (const line of result.stdout.split("\n")) {
      //   sl  local_address rem_address  st ...
      //    0: 00000000:1F90 00000000:0000 0A ...   (wildcard v4)
      //    0: 0100007F:AEB3 00000000:0000 0A ...   (loopback v4 — skip)
      const cols = line.trim().split(/\s+/);
      if (cols[3] !== "0A") continue;
      const [hexAddr, hexPort] = cols[1]?.split(":") ?? [];
      if (!hexAddr || !hexPort) continue;
      // Only include ports bound to wildcard (0.0.0.0 or ::), skip loopback
      if (hexAddr !== "00000000" && hexAddr !== "00000000000000000000000000000000")
        continue;
      ports.add(parseInt(hexPort, 16));
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Get the image ID that `avm:latest` currently points to.
 * Returns null if the image doesn't exist (never provisioned).
 */
async function getCurrentImageId(): Promise<string | null> {
  try {
    const result =
      await $`docker inspect --format={{.Id}} avm:latest`.quiet();
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get the image ID a container was created from.
 */
async function getContainerImageId(
  containerName: string,
): Promise<string | null> {
  try {
    const result =
      await $`docker inspect --format={{.Image}} ${containerName}`.quiet();
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * List avm containers. Uses `docker ps -a` filtered by the avm label.
 * Docker outputs one JSON object per line (not a JSON array).
 */
export async function listAvmVms(): Promise<VmInfo[]> {
  const [psResult, currentImageId] = await Promise.all([
    $`docker ps -a --filter label=${AVM_LABEL} --format json`.quiet(),
    getCurrentImageId(),
  ]);
  const lines = psResult.stdout.trim().split("\n").filter(Boolean);
  const vms = lines.map((line) => {
    const entry = JSON.parse(line) as DockerPsEntry;
    const name = entry.Names.replace(/^\//, "");
    return {
      id: name.startsWith("avm-") ? name.slice(4) : name,
      name,
      status: entry.State === "exited" ? "stopped" : entry.State,
      ports: [] as number[],
      outdated: false,
    };
  });

  await Promise.all(
    vms.map(async (vm) => {
      const tasks: Promise<void>[] = [];
      if (vm.status === "running") {
        tasks.push(
          getListeningPorts(vm.name).then((ports) => {
            vm.ports = ports;
          }),
        );
      }
      if (currentImageId) {
        tasks.push(
          getContainerImageId(vm.name).then((id) => {
            vm.outdated = id !== null && id !== currentImageId;
          }),
        );
      }
      await Promise.all(tasks);
    }),
  );

  return vms;
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
