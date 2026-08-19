---
name: avm-services
description: Use when you need a host service or when a project expects local services. Must be consulted before starting your own copies of services that may already be available on the host.
---

# Host services

Some services run on the host machine and are shared across all avm
containers. Use `avm-bridge service` to control them instead of
starting your own copies.

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
avm-bridge service start <name>    # idempotent — safe to call even if UP
```

## What's available

Run `avm-bridge service ls` to see which services the user has
declared. The specific services depend on the user's configuration.

## Connecting to host services

`check.tcp` is a host-side health check, not a container endpoint. Services
that declare `endpoint.port` can be reached with:

```
avm-bridge service endpoint <name>
avm-bridge service endpoint <name> --ipv4
```

The default prints `host.docker.internal:<port>`. Use `--ipv4` for clients
that require a numeric HTTP Host header.

### Chrome DevTools MCP

Chrome is the primary use case for `--ipv4`: Chrome rejects the
`host.docker.internal` HTTP Host header. For a declared `chrome` service,
configure Chrome DevTools MCP to start the service and use its numeric endpoint:

```
sh -c 'avm-bridge service start chrome >&2 && endpoint=$(avm-bridge service endpoint chrome --ipv4) && exec npx -y chrome-devtools-mcp@latest --browser-url=http://$endpoint'
```

Do not start an in-container browser or configure Chrome DevTools MCP with
`localhost` or the service health-check address.
