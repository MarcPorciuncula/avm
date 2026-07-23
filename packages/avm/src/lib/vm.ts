import { $ } from "zx";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { AVM_LABEL, SSH_PORT_LABEL } from "./config.ts";

export interface VmInfo {
  /** Short ID — the suffix after `avm-`. */
  id: string;
  /** Full container name, e.g. `avm-k7xf2`. */
  name: string;
  /** Container state: "running" | "stopped" | other. */
  status: string;
  /** True if the container's image no longer matches `avm:latest`. */
  outdated: boolean;
  /** SSH port assigned to this container (from label), or null if not set. */
  sshPort: number | null;
  /** Hostname the macOS host uses to reach this container's sshd. */
  sshHost: string;
}

interface DockerPsEntry {
  Names: string;
  State: string;
  Labels: string;
  Networks: string;
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
    // Parse SSH port from labels string (comma-separated "key=value" pairs)
    let sshPort: number | null = null;
    const portLabel = entry.Labels?.split(",")
      .find((l) => l.startsWith(`${SSH_PORT_LABEL}=`));
    if (portLabel) {
      const parsed = parseInt(portLabel.split("=")[1]!, 10);
      if (!isNaN(parsed)) sshPort = parsed;
    }
    return {
      id: name.startsWith("avm-") ? name.slice(4) : name,
      name,
      status: entry.State === "exited" ? "stopped" : entry.State,
      outdated: false,
      sshPort,
      sshHost: entry.Networks.split(",").includes("host")
        ? "localhost"
        : `${name}.orb.local`,
    };
  });

  await Promise.all(
    vms.map(async (vm) => {
      const tasks: Promise<void>[] = [];
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

/**
 * Resolve an optional user-provided VM argument to a single VmInfo.
 *
 * - input defined → delegates to resolveVmByPrefix(input, vms).vm
 * - input undefined, no VMs → throws
 * - input undefined, exactly one VM → logs and returns it
 * - input undefined, multiple VMs → throws with a list
 */
export function resolveVmArg(
  input: string | undefined,
  vms: VmInfo[],
): VmInfo {
  if (input !== undefined) {
    return resolveVmByPrefix(input, vms).vm;
  }
  if (vms.length === 0) {
    throw new Error("No avm containers found.");
  }
  if (vms.length === 1) {
    const vm = vms[0]!;
    console.log(`Using ${vm.name}`);
    return vm;
  }
  const list = vms.map((vm) => ` - ${vm.id}`).join("\n");
  throw new Error(`Multiple containers exist — specify one:\n${list}`);
}

/**
 * Try to open a TCP connection to host:port. Resolves true on connect,
 * false on any error (refused, reset, timeout).
 */
function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

/**
 * Start sshd inside a container if not already running, then wait until the
 * port is reachable from the host.
 *
 * sshd without -D daemonizes before the listen socket is bound, and under
 * OrbStack there is additional propagation delay from the container's
 * network namespace to the host — so start-sshd.sh returning 0 doesn't mean
 * an ssh client on the host can connect yet. Poll until it can.
 */
export async function ensureSshd(
  vmName: string,
  sshHost: string,
  sshPort: number,
): Promise<void> {
  await $`docker exec -u root -e AVM_SSH_PORT=${sshPort} ${vmName} /opt/avm/start-sshd.sh`;

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await canConnect(sshHost, sshPort, 500)) return;
    await delay(100);
  }
  throw new Error(
    `sshd started in ${vmName} but ${sshHost}:${sshPort} is not reachable after 5s.`,
  );
}

/**
 * SSH into a container. Starts sshd first, then execs ssh.
 * Returns the exit code of the ssh process.
 */
export function sshToVm(sshHost: string, sshPort: number): number {
  const result = spawnSync(
    "ssh",
    [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-p", String(sshPort),
      "-t",
      `agent@${sshHost}`,
      "cd ~/work && exec bash -l",
    ],
    { stdio: "inherit" },
  );
  return result.status ?? 1;
}
