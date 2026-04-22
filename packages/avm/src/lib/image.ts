import { $, path } from "zx";
import { existsSync } from "node:fs";
import { AVM_HOME, REPO_ROOT, USER_IMAGE } from "./config.ts";

const USER_DOCKERFILE = path.join(AVM_HOME, "Dockerfile");
const USER_BUILD_CONTEXT = path.join(AVM_HOME, "build-context");

/** Matches the timestamped tags produced by buildUserImage (UTC, second precision). */
const TIMESTAMP_TAG_PATTERN = /^\d{8}-\d{6}$/;

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
 */
export async function buildCoreImage(): Promise<void> {
  const dockerfile = path.join(REPO_ROOT, "dockerfiles", "core.Dockerfile");
  console.log("==> Building avm-core image...");
  await $`docker build -t avm-core:latest -f ${dockerfile} ${REPO_ROOT}`;
}

/**
 * Build the user's image from ~/.avm/Dockerfile.
 *
 * The user Dockerfile layers toolchain installs (Go, Python, Docker CLI,
 * etc.) on top of avm-core:latest. The build context is ~/.avm/build-context/
 * so users can COPY files they need into the image.
 *
 * Returns the timestamped tag (e.g. "20260411-143022").
 */
export async function buildUserImage(): Promise<string> {
  if (!existsSync(USER_DOCKERFILE)) {
    throw new Error(
      `${USER_DOCKERFILE} not found.\n` +
        `Create a Dockerfile at ${USER_DOCKERFILE} to define your toolchain layer.\n` +
        `See examples/Dockerfile in the avm repo for a starting point:\n` +
        `  cp ${REPO_ROOT}/examples/Dockerfile ${USER_DOCKERFILE}`,
    );
  }

  await $`mkdir -p ${USER_BUILD_CONTEXT}`;

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
  await $`docker build -t ${tagTimestamped} -t ${tagLatest} -f ${USER_DOCKERFILE} ${USER_BUILD_CONTEXT}`;

  return ts;
}

/**
 * Build both images in sequence: core first, then user layer.
 * Returns the timestamped tag of the user image.
 */
export async function provisionImages(): Promise<string> {
  await buildCoreImage();
  return await buildUserImage();
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
