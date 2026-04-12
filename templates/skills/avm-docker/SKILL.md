---
name: avm-docker
description: Use when the agent needs to run Docker, docker-compose, build images, or start containers inside the avm sandbox.
---

# Docker in avm

Docker runs locally inside this container (Docker-in-Docker). The
daemon is **not** running by default — start it first:

```
start-dockerd
```

The command is idempotent — safe to run if the daemon is already up.

## Daemon lifecycle

- `start-dockerd` launches `dockerd` in the background and waits
  until it's ready.
- The daemon stays running until the container stops.
- After a container restart (`avm stop` / `avm start`), run
  `start-dockerd` again.

## Bind mounts and docker-compose

Because the daemon runs locally, bind mounts work normally. Paths
like `/home/agent/work/...` resolve correctly:

```
docker run -v /home/agent/work/myapp/src:/app/src myimage
```

`docker compose` with bind mounts also works as expected.
