import { $, path } from "zx";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { AVM_HOME, REPO_ROOT, USER_IMAGE } from "./config.ts";

const BUILD_HASH_LABEL = "avm.build-hash";

const USER_DOCKERFILE = path.join(AVM_HOME, "Dockerfile");
const USER_BUILD_CONTEXT = path.join(AVM_HOME, "build-context");

/** Matches the timestamped tags produced by buildUserImage (UTC, second precision). */
const TIMESTAMP_TAG_PATTERN = /^\d{8}-\d{6}$/;

// ---------------------------------------------------------------------------
// Hash utilities
// ---------------------------------------------------------------------------

/** Compute the SHA-256 hex digest of a file's contents. Throws if missing. */
function hashFile(filePath: string): string {
  const contents = readFileSync(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Compute a stable SHA-256 hex digest of all files under dirPath.
 * Files are sorted by relative path for determinism.
 * Returns the string 'empty' if the directory does not exist.
 */
function hashDirectory(dirPath: string): string {
  if (!existsSync(dirPath)) return "empty";

  const SKIP_DIRS = new Set([".git", "node_modules"]);
  const collect = (dir: string, base: string): { rel: string; abs: string }[] => {
    const entries: { rel: string; abs: string }[] = [];
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = path.join(base, name);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        entries.push(...collect(abs, rel));
      } else {
        entries.push({ rel, abs });
      }
    }
    return entries;
  };

  const files = collect(dirPath, "");
  const combined = createHash("sha256");
  for (const { rel, abs } of files) {
    combined.update(createHash("sha256").update(rel).digest("hex"));
    combined.update(createHash("sha256").update(readFileSync(abs)).digest("hex"));
  }
  return combined.digest("hex");
}

/** Compute the content hash for the core image build inputs. */
function computeCoreImageHash(): string {
  const df = hashFile(path.join(REPO_ROOT, "dockerfiles", "core.Dockerfile"));
  const tmpl = hashDirectory(path.join(REPO_ROOT, "templates"));
  return createHash("sha256").update(df).update(tmpl).digest("hex");
}

/** Compute the content hash for the user image build inputs. */
function computeUserImageHash(): string {
  // The user image is `FROM avm-core:latest`, so a core rebuild leaves
  // existing user images layered on top of a stale snapshot. Fold the core
  // hash in so changes to core.Dockerfile or templates/ also invalidate the
  // user image.
  const core = computeCoreImageHash();
  const df = hashFile(USER_DOCKERFILE);
  const ctx = hashDirectory(USER_BUILD_CONTEXT);
  return createHash("sha256").update(core).update(df).update(ctx).digest("hex");
}

/**
 * Read the avm.build-hash label from an existing Docker image.
 * Returns null if the image does not exist or the label is absent.
 */
async function getImageBuildHash(imageRef: string): Promise<string | null> {
  try {
    const result =
      await $`docker inspect --format=${"{{index .Config.Labels \"" + BUILD_HASH_LABEL + "\"}}"} ${imageRef}`.quiet();
    const value = result.stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

export interface PruneResult {
  removed: string[];
  skipped: { tag: string; reason: string }[];
}

/**
 * Build the core avm image from dockerfiles/core.Dockerfile.
 *
 * This image contains the minimal base every avm container needs:
 * system packages, Node.js, Claude Code, the agent user, and
 * /opt/avm/helpers.sh. It is tagged as avm-core:latest.
 *
 * Returns true if the image was built, false if skipped.
 */
export async function buildCoreImage(force = false): Promise<boolean> {
  const dockerfile = path.join(REPO_ROOT, "dockerfiles", "core.Dockerfile");
  const hash = computeCoreImageHash();

  if (!force) {
    const existing = await getImageBuildHash("avm-core:latest");
    if (existing === hash) {
      console.log("==> avm-core is up to date. Use --force to rebuild.");
      return false;
    }
  }

  console.log("==> Building avm-core image...");
  const noCache = force ? ["--no-cache"] : [];
  await $`docker build ${noCache} -t avm-core:latest --label ${BUILD_HASH_LABEL}=${hash} -f ${dockerfile} ${REPO_ROOT}`;
  return true;
}

/**
 * Build the user's image from ~/.avm/Dockerfile.
 *
 * The user Dockerfile layers toolchain installs (Go, Python, Docker CLI,
 * etc.) on top of avm-core:latest. The build context is ~/.avm/build-context/
 * so users can COPY files they need into the image.
 *
 * Returns the timestamped tag (e.g. "20260411-143022"), or null if skipped.
 */
export async function buildUserImage(force = false): Promise<string | null> {
  if (!existsSync(USER_DOCKERFILE)) {
    throw new Error(
      `${USER_DOCKERFILE} not found.\n` +
        `Create a Dockerfile at ${USER_DOCKERFILE} to define your toolchain layer.\n` +
        `See examples/Dockerfile in the avm repo for a starting point:\n` +
        `  cp ${REPO_ROOT}/examples/Dockerfile ${USER_DOCKERFILE}`,
    );
  }

  await $`mkdir -p ${USER_BUILD_CONTEXT}`;

  const hash = computeUserImageHash();

  if (!force) {
    const existing = await getImageBuildHash("avm:latest");
    if (existing === hash) {
      console.log("==> avm (user image) is up to date. Use --force to rebuild.");
      return null;
    }
  }

  const now = new Date();
  const ts = [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    "-",
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
  ].join("");

  const tagTimestamped = `avm:${ts}`;
  const tagLatest = "avm:latest";

  console.log(`==> Building user image (${tagTimestamped})...`);
  const noCache = force ? ["--no-cache"] : [];
  await $`docker build ${noCache} -t ${tagTimestamped} -t ${tagLatest} --label ${BUILD_HASH_LABEL}=${hash} -f ${USER_DOCKERFILE} ${USER_BUILD_CONTEXT}`;

  return ts;
}

/**
 * Build both images in sequence: core first, then user layer.
 * Returns the timestamped tag of the user image, or null if the user image was skipped.
 */
export async function provisionImages(force = false): Promise<string | null> {
  await buildCoreImage(force);
  return await buildUserImage(force);
}

/**
 * Remove old timestamped `avm:<YYYYMMDD-HHMMSS>` tags, keeping the
 * `keepRecent` most recent ones (plus the tag matching the current
 * `avm:latest`, even if older). Tags whose underlying image is still in
 * use by a container are skipped — Docker would refuse `rmi` anyway.
 *
 * Only the user image (`avm`) is pruned. The core image (`avm-core`) has
 * a single `:latest` tag and isn't versioned, so there's nothing to prune.
 */
export async function pruneOldUserImages(
  keepRecent: number,
): Promise<PruneResult> {
  const tags = await listTimestampedUserTags();
  // Newest first.
  tags.sort().reverse();

  const latestId = await getImageId(`${USER_IMAGE}:latest`);
  const keep = new Set<string>(tags.slice(0, Math.max(0, keepRecent)));
  if (latestId) {
    for (const tag of tags) {
      const id = await getImageId(`${USER_IMAGE}:${tag}`);
      if (id === latestId) {
        keep.add(tag);
      }
    }
  }

  const result: PruneResult = { removed: [], skipped: [] };
  for (const tag of tags) {
    if (keep.has(tag)) continue;
    const ref = `${USER_IMAGE}:${tag}`;
    try {
      await $`docker rmi ${ref}`.quiet();
      result.removed.push(ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const inUse = /image is being used|conflict.*container/i.test(message);
      result.skipped.push({
        tag: ref,
        reason: inUse ? "in use by a container" : message.split("\n")[0],
      });
    }
  }
  return result;
}

/** Return the timestamp portion of every `avm:<timestamp>` tag on the host. */
async function listTimestampedUserTags(): Promise<string[]> {
  const result =
    await $`docker images --format={{.Tag}} ${USER_IMAGE}`.quiet();
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((tag) => TIMESTAMP_TAG_PATTERN.test(tag));
}

/** Resolve a tagged reference to its image ID, or null if missing. */
async function getImageId(ref: string): Promise<string | null> {
  try {
    const result = await $`docker inspect --format={{.Id}} ${ref}`.quiet();
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}
