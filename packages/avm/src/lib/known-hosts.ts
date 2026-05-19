import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { $ } from "zx";
import type { VmInfo } from "./vm.ts";

/**
 * Why this module exists
 * ----------------------
 * The Claude desktop app connects to avm containers with its own SSH client,
 * not the system `ssh` binary. That client performs `~/.ssh/known_hosts`
 * host-key verification and does NOT honour the `StrictHostKeyChecking no` /
 * `UserKnownHostsFile /dev/null` directives avm writes into `~/.avm/ssh_config`
 * (those only take effect for the system `ssh` binary, which is why `avm ssh`
 * works). Because avm deliberately routes host keys to `/dev/null`, a fresh
 * container's key is never in `~/.ssh/known_hosts`, so the desktop app rejects
 * the connection with "Host denied (verification failed)".
 *
 * To make the desktop integration work, the desktop-config sync also
 * reconciles a managed block in `~/.ssh/known_hosts` with the live containers'
 * host keys (scanned via `ssh-keyscan`). This is gated on the desktop
 * integration being enabled: it runs only from `syncDesktopConfig`, so users
 * who never opt in never have `~/.ssh/known_hosts` touched.
 */

const MARKER_START = "# >>> avm managed (known_hosts) >>>";
const MARKER_END = "# <<< avm managed (known_hosts) <<<";

/**
 * Ownership boundary. avm assigns every container a deterministic SSH port in
 * 22000–22999 (`sshPortForId`), mapped onto `localhost`. Any
 * `[localhost]:<port>` entry in that range is therefore avm-owned and safe to
 * reconcile — directly analogous to `desktop-config.ts` owning `sshConfigs`
 * entries whose id matches `^avm-[a-z0-9]{5}$`. Everything else in
 * `~/.ssh/known_hosts` is preserved verbatim.
 */
const AVM_PORT_MIN = 22000;
const AVM_PORT_MAX = 22999;

function knownHostsPath(): string {
  return join(os.homedir(), ".ssh", "known_hosts");
}

function readKnownHosts(): string {
  const p = knownHostsPath();
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function writeKnownHosts(contents: string): void {
  const p = knownHostsPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, p);
}

/**
 * True if `line` is an avm-owned known_hosts entry: every comma-separated host
 * pattern in its first field is `[localhost]:<port>` for a port in avm's
 * reserved range. Mixed lines (an avm pattern alongside unrelated hostnames)
 * and hashed entries (`|1|…`) are intentionally left untouched.
 */
function isAvmOwnedLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return false;
  const hostField = trimmed.split(/\s+/)[0];
  if (!hostField) return false;
  const patterns = hostField.split(",");
  return patterns.every((pat) => {
    const m = /^\[localhost\]:(\d+)$/.exec(pat);
    if (!m) return false;
    const port = Number(m[1]);
    return port >= AVM_PORT_MIN && port <= AVM_PORT_MAX;
  });
}

/** Drop avm's marker block and any avm-owned line outside it. */
function stripAvmEntries(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === MARKER_START) {
      inBlock = true;
      continue;
    }
    if (line.trim() === MARKER_END) {
      inBlock = false;
      continue;
    }
    if (inBlock) continue;
    if (isAvmOwnedLine(line)) continue;
    out.push(line);
  }
  return out;
}

/**
 * Scan a container's sshd for its host keys. Best-effort: a short timeout, and
 * any failure (sshd not up yet, port unreachable) yields no lines rather than
 * aborting the whole sync — a missing key for one container must not break
 * `avm create`/`avm clean`.
 */
async function scanHostKeys(port: number): Promise<string[]> {
  try {
    const result = await $({
      nothrow: true,
    })`ssh-keyscan -T 5 -p ${port} -t rsa,ecdsa,ed25519 localhost`.quiet();
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Re-converge the avm-managed block in `~/.ssh/known_hosts` with the host keys
 * of the currently running avm containers. Stale entries (cleaned or recreated
 * containers, including pre-feature orphans left outside the block) are dropped
 * so a recycled port never trips a changed-key verification failure. All
 * non-avm known_hosts lines are preserved verbatim.
 */
export async function reconcileKnownHosts(vms: VmInfo[]): Promise<void> {
  const targets = vms.filter(
    (vm) => vm.status === "running" && vm.sshPort != null,
  );

  const scanned = await Promise.all(
    targets.map((vm) => scanHostKeys(vm.sshPort as number)),
  );
  // ssh-keyscan returns key types in nondeterministic order; sort so repeated
  // syncs produce a byte-identical block (idempotent, no churn).
  const managedLines = scanned.flat().sort();

  const preserved = stripAvmEntries(readKnownHosts());
  // Trim trailing blank lines the strip may have left, then rebuild.
  while (preserved.length > 0 && preserved[preserved.length - 1] === "") {
    preserved.pop();
  }

  const block = [MARKER_START, ...managedLines, MARKER_END].join("\n");
  const body = preserved.length > 0 ? preserved.join("\n") + "\n\n" : "";
  writeKnownHosts(`${body}${block}\n`);
}

/**
 * Remove avm's managed block and any avm-owned entries from
 * `~/.ssh/known_hosts`. Used by desktop-config uninstall. No-op if the file is
 * missing or contains nothing avm-owned.
 */
export function removeManagedKnownHosts(): void {
  const p = knownHostsPath();
  if (!existsSync(p)) return;
  const current = readKnownHosts();
  const preserved = stripAvmEntries(current);
  while (preserved.length > 0 && preserved[preserved.length - 1] === "") {
    preserved.pop();
  }
  const next = preserved.length > 0 ? preserved.join("\n") + "\n" : "";
  if (next !== current) writeKnownHosts(next);
}
