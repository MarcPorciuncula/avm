import { defineCommand } from "citty";
import { provisionImages, pruneOldUserImages } from "../../lib/image.ts";
import { loadAvmConfig } from "../../lib/config-file.ts";

export const provisionCommand = defineCommand({
  meta: {
    name: "provision",
    description:
      "Build the avm-core and user Docker images for agent containers.",
  },
  async run() {
    const tag = await provisionImages();

    console.log();
    console.log(`Done. Images built — avm:${tag} / avm:latest.`);

    const config = loadAvmConfig();
    if (config.prune_images.enabled) {
      console.log();
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

    console.log();
    console.log(`Start an agent session: avm create --attach`);
  },
});
