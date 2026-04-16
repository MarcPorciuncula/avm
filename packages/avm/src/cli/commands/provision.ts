import { defineCommand } from "citty";
import { provisionImages } from "../../lib/image.ts";

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
    console.log(`Start an agent session: avm create --attach`);
  },
});
