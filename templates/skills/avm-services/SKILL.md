---
name: avm-services
description: Use when you need a host service (Chrome, Postgres, etc.) or when a project expects local services. Must be consulted before starting your own copies of services that may already be available on the host.
---

# Host services

Services like Chrome (remote debugging), Postgres, and others run on
the host machine and are shared across all avm containers. Use
`avm-bridge service` to control them instead of starting your own
copies.

## Check before duplicating

If a project's README or `docker-compose.yaml` asks you to start a
local database, cache, or browser — check `avm-bridge service ls`
first. The host may already provide it.

## Commands

```
avm-bridge service ls                # list declared services + state
avm-bridge service status <name>     # check if a service is running
avm-bridge service start <name>      # start (idempotent, no-op if UP)
avm-bridge service stop <name>       # stop (idempotent, no-op if DOWN)
```

## Resilience

Services may stop at any time — the user may close them, another
agent may stop them, or they may crash. Always check status before
use and be prepared to restart:

```
avm-bridge service start chrome    # idempotent — safe to call even if UP
```

## What's available

Run `avm-bridge service ls` to see which services the user has
declared. Common examples:

- **chrome** — Chrome with remote debugging (CDP on localhost:9222).
  Used by the `chrome-devtools` MCP.
- **postgres** — Postgres on localhost:5432.

The specific services depend on the user's `~/.avm/config.yaml`.
