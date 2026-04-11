import { $, path } from "zx";
import { existsSync } from "node:fs";
import { AVM_HOME, REPO_ROOT } from "./config.ts";

const USER_DOCKERFILE = path.join(AVM_HOME, "Dockerfile");
const USER_BUILD_CONTEXT = path.join(AVM_HOME, "build-context");

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
    console.error(`Error: ${USER_DOCKERFILE} not found.`);
    console.error(
      `Create a Dockerfile at ${USER_DOCKERFILE} to define your toolchain layer.`,
    );
    console.error(
      `See examples/Dockerfile in the avm repo for a starting point:`,
    );
    console.error(`  cp ${REPO_ROOT}/examples/Dockerfile ${USER_DOCKERFILE}`);
    process.exit(1);
  }

  await $`mkdir -p ${USER_BUILD_CONTEXT}`;

  const now = new Date();
  const ts = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
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
