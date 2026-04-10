import { defineCommand } from "citty";
import { $, path } from "zx";
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  ALL_REPOS,
  BASE_VM_NAME,
  GITHUB_ORG,
  REPO_DEPS,
  cacheDir,
  claudeDir,
  credentialsDir,
  envsDir,
  mirrorsDir,
  vmHostPrefix,
} from "../../lib/config.ts";
import {
  asAgent,
  asRoot,
  generateSessionName,
  listAvmVms,
  normalizeVmName,
  waitForSsh,
} from "../../lib/vm.ts";
import { updateMirrors } from "../../lib/mirrors.ts";

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description: "Create and start a new agent VM.",
  },
  args: {
    name: {
      type: "positional",
      required: false,
      description:
        "Suffix for the VM name (avm- is prepended automatically). Random if omitted.",
    },
    clone: {
      type: "boolean",
      description:
        "Reference-clone all known repos into ~/work/<repo> and symlink .env files from ~/envs.",
    },
    attach: {
      type: "boolean",
      description: "After setup, exec into the VM via SSH.",
    },
  },
  async run({ args }) {
    const vmName = args.name
      ? normalizeVmName(args.name)
      : generateSessionName();

    const existing = await listAvmVms();
    if (existing.some((v) => v.name === vmName)) {
      console.error(`Error: VM ${vmName} already exists.`);
      process.exit(1);
    }

    // Ensure host-side data directories exist.
    const requiredDirs = [
      path.join(credentialsDir, "ssh"),
      path.join(credentialsDir, "git"),
      path.join(cacheDir, "shared", "pnpm-store"),
      claudeDir,
      mirrorsDir,
      envsDir,
    ];
    for (const dir of requiredDirs) {
      mkdirSync(dir, { recursive: true });
    }

    if (args.clone) {
      console.log("==> Ensuring mirrors are fresh...");
      await updateMirrors(ALL_REPOS);
    }

    console.log(`==> Cloning ${BASE_VM_NAME} -> ${vmName}...`);
    await $`orb clone ${BASE_VM_NAME} ${vmName}`;
    await $`orb start ${vmName}`;
    console.log("==> Waiting for SSH...");
    await waitForSsh(vmName);

    console.log("==> Setting up bind-mounts...");
    await asRoot(
      vmName,
      `
      mkdir -p /home/agent/.ssh /home/agent/.claude /home/agent/.local/share/pnpm/store /home/agent/mirrors /home/agent/envs

      mount --bind ${vmHostPrefix}/data/credentials/ssh /home/agent/.ssh
      mount --bind ${vmHostPrefix}/data/claude /home/agent/.claude
      mount --bind ${vmHostPrefix}/data/cache/shared/pnpm-store /home/agent/.local/share/pnpm/store
      mount --bind ${vmHostPrefix}/data/mirrors /home/agent/mirrors
      mount --bind ${vmHostPrefix}/data/envs /home/agent/envs

      chown -R agent:agent /home/agent/.ssh /home/agent/.claude /home/agent/.local /home/agent/mirrors /home/agent/envs
    `,
    );

    console.log("==> Copying git config...");
    await asRoot(
      vmName,
      `
      cp ${vmHostPrefix}/data/credentials/git/.gitconfig /home/agent/.gitconfig
      chown agent:agent /home/agent/.gitconfig
    `,
    );

    if (args.clone) {
      console.log("==> Cloning repos...");
      for (const repo of ALL_REPOS) {
        console.log(`    ${repo}...`);
        await asAgent(
          vmName,
          `
          git clone --reference /home/agent/mirrors/${repo}.git \
            git@github.com:${GITHUB_ORG}/${repo}.git \
            /home/agent/work/${repo}
        `,
        );
      }

      for (const primaryRepo of Object.keys(REPO_DEPS)) {
        const envFile = path.join(envsDir, `${primaryRepo}.env`);
        if (existsSync(envFile)) {
          console.log(`==> Symlinking .env for ${primaryRepo}...`);
          await asAgent(
            vmName,
            `
            ln -sf /home/agent/envs/${primaryRepo}.env /home/agent/work/${primaryRepo}/.env
          `,
          );
        }
      }
    }

    console.log("==> Locking down host mount...");
    await asRoot(
      vmName,
      `
      mkdir -p /tmp/empty-mnt /tmp/empty-users
      mount --bind /tmp/empty-mnt /mnt/mac
      mount --bind /tmp/empty-users /Users
    `,
    );

    console.log();
    console.log("Session ready.");
    console.log();
    console.log(`  SSH: ssh ${vmName}@orb`);
    console.log();

    if (args.attach) {
      console.log(`==> Attaching to ${vmName}...`);
      const result = spawnSync("ssh", ["-t", `${vmName}@orb`], {
        stdio: "inherit",
      });
      process.exit(result.status ?? 0);
    }
  },
});
