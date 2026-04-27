import { defineCommand } from "citty";
import { provisionImages, pruneOldUserImages } from "../../lib/image.ts";
import { loadAvmConfig } from "../../lib/config-file.ts";
import { maybePromptForInstall } from "./notify.ts";

export const provisionCommand = defineCommand({
  meta: {
    name: "provision",
    description:
      "Build the avm-core and user Docker images for agent containers.",
  },
  args: {
    force: {
      type: "boolean",
      description:
        "Rebuild from scratch: bypass the input-hash check and pass --no-cache to docker build.",
      alias: "f",
      default: false,
    },
  },
  async run({ args }) {
    const tag = await provisionImages(args.force);

    if (tag === null) {
      console.log();
      console.log("Nothing to provision — both images are up to date.");
      console.log("Run with --force to rebuild unconditionally.");
      console.log();
    } else {
      console.log();
      console.log(`Done. Images built — avm:${tag} / avm:latest.`);
      console.log();
      console.log("Start an agent session: avm create --attach");
      console.log();
    }

    const config = loadAvmConfig();
    if (config.prune_images.enabled) {
      console.log(
        `==> Pruning old avm images (keep_recent=${config.prune_images.keep_recent})...`,
      );
      const result = await pruneOldUserImages(config.prune_images.keep_recent);
      if (result.removed.length === 0 && result.skipped.length === 0) {
        console.log("Nothing to prune.");
      } else {
        for (const ref of result.removed) console.log(`  removed ${ref}`);
        for (const { tag: ref, reason } of result.skipped) {
          console.log(`  kept    ${ref} (${reason})`);
        }
      }
    }

    // First-run prompt for host notifications. No-op if already answered.
    await maybePromptForInstall();
  },
});
