import type { ConnectRouter } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ConnectError, Code } from "@connectrpc/connect";

import {
  EditorService as BridgeEditorService,
  OpenFileResponseSchema,
} from "@avm/shared/gen/avm/bridge/v1/editor_pb";
import {
  ServicesService as BridgeServicesService,
  ServiceSchema as BridgeServiceSchema,
  ListServicesResponseSchema as BridgeListServicesResponseSchema,
  Kind as BridgeKind,
  State as BridgeState,
} from "@avm/shared/gen/avm/bridge/v1/services_pb";
import {
  ServicesService as HostServicesService,
  ServiceSchema as HostServiceSchema,
  ListServicesResponseSchema as HostListServicesResponseSchema,
  Kind as HostKind,
  State as HostState,
} from "@avm/shared/gen/avm/host/v1/services_pb";
import {
  ContainerService,
  RegisterContainerResponseSchema,
  UnregisterContainerResponseSchema,
} from "@avm/shared/gen/avm/host/v1/containers_pb";

import { openFile } from "./editor.js";
import type { ServiceRegistry, ServiceConfig, ServiceStatus } from "./registry.js";
import type { StateStore } from "./state.js";

/** Map a registry kind string to the proto Kind enum. */
function toBridgeKind(kind: ServiceConfig["kind"]): BridgeKind {
  return kind === "process" ? BridgeKind.PROCESS : BridgeKind.DOCKER;
}

function toHostKind(kind: ServiceConfig["kind"]): HostKind {
  return kind === "process" ? HostKind.PROCESS : HostKind.DOCKER;
}

/** Map a registry state string to the proto State enum. */
const bridgeStateMap: Record<ServiceStatus["state"], BridgeState> = {
  up: BridgeState.UP,
  down: BridgeState.DOWN,
  starting: BridgeState.STARTING,
  stopping: BridgeState.STOPPING,
  unknown: BridgeState.UNKNOWN,
};

const hostStateMap: Record<ServiceStatus["state"], HostState> = {
  up: HostState.UP,
  down: HostState.DOWN,
  starting: HostState.STARTING,
  stopping: HostState.STOPPING,
  unknown: HostState.UNKNOWN,
};

function getServiceConfig(
  name: string,
  loadConfig: () => Record<string, ServiceConfig>,
): ServiceConfig {
  const configs = loadConfig();
  const config = configs[name];
  if (!config) {
    throw new ConnectError(`service not found: ${name}`, Code.NotFound);
  }
  return config;
}

export function createRoutes(
  registry: ServiceRegistry,
  stateStore: StateStore,
  loadConfig: () => Record<string, ServiceConfig>,
): (router: ConnectRouter) => void {
  return (router: ConnectRouter) => {
    // Bridge services API (called by containers)
    router.service(BridgeServicesService, {
      async listServices() {
        const configs = loadConfig();
        const services = await Promise.all(
          Object.entries(configs).map(async ([name, config]) => {
            const status = await registry.getStatus(name, config);
            return create(BridgeServiceSchema, {
              name: status.name,
              kind: toBridgeKind(status.kind),
              state: bridgeStateMap[status.state],
              pid: status.pid,
              lastError: status.lastError,
              lastCheckAt: timestampFromDate(status.lastCheckAt),
            });
          }),
        );
        return create(BridgeListServicesResponseSchema, { services });
      },

      async getService(req) {
        const config = getServiceConfig(req.name, loadConfig);
        const status = await registry.getStatus(req.name, config);
        return create(BridgeServiceSchema, {
          name: status.name,
          kind: toBridgeKind(status.kind),
          state: bridgeStateMap[status.state],
          pid: status.pid,
          lastError: status.lastError,
          lastCheckAt: timestampFromDate(status.lastCheckAt),
        });
      },

      async startService(req) {
        const config = getServiceConfig(req.name, loadConfig);
        const status = await registry.start(req.name, config);
        return create(BridgeServiceSchema, {
          name: status.name,
          kind: toBridgeKind(status.kind),
          state: bridgeStateMap[status.state],
          pid: status.pid,
          lastError: status.lastError,
          lastCheckAt: timestampFromDate(status.lastCheckAt),
        });
      },

      async stopService(req) {
        const config = getServiceConfig(req.name, loadConfig);
        const status = await registry.stop(req.name, config);
        return create(BridgeServiceSchema, {
          name: status.name,
          kind: toBridgeKind(status.kind),
          state: bridgeStateMap[status.state],
          pid: status.pid,
          lastError: status.lastError,
          lastCheckAt: timestampFromDate(status.lastCheckAt),
        });
      },
    });

    // Bridge editor API (called by containers)
    router.service(BridgeEditorService, {
      async openFile(req, context) {
        const containerName = context.requestHeader.get("x-avm-container-name");
        if (!containerName) {
          throw new ConnectError("Container identity not resolved", Code.Internal);
        }
        const result = openFile(containerName, {
          path: req.path,
          line: req.line,
          column: req.column,
          editor: req.editor,
        });
        return create(OpenFileResponseSchema, {
          editor: result.editor,
          sshHost: result.sshHost,
          command: result.command,
        });
      },
    });

    // Host services API (called by the host CLI)
    router.service(HostServicesService, {
      async listServices() {
        const configs = loadConfig();
        const services = await Promise.all(
          Object.entries(configs).map(async ([name, config]) => {
            const status = await registry.getStatus(name, config);
            return create(HostServiceSchema, {
              name: status.name,
              kind: toHostKind(status.kind),
              state: hostStateMap[status.state],
              pid: status.pid,
              lastError: status.lastError,
              lastCheckAt: timestampFromDate(status.lastCheckAt),
            });
          }),
        );
        return create(HostListServicesResponseSchema, { services });
      },

      async getService(req) {
        const config = getServiceConfig(req.name, loadConfig);
        const status = await registry.getStatus(req.name, config);
        return create(HostServiceSchema, {
          name: status.name,
          kind: toHostKind(status.kind),
          state: hostStateMap[status.state],
          pid: status.pid,
          lastError: status.lastError,
          lastCheckAt: timestampFromDate(status.lastCheckAt),
        });
      },

      async startService(req) {
        const config = getServiceConfig(req.name, loadConfig);
        const status = await registry.start(req.name, config);
        return create(HostServiceSchema, {
          name: status.name,
          kind: toHostKind(status.kind),
          state: hostStateMap[status.state],
          pid: status.pid,
          lastError: status.lastError,
          lastCheckAt: timestampFromDate(status.lastCheckAt),
        });
      },

      async stopService(req) {
        const config = getServiceConfig(req.name, loadConfig);
        const status = await registry.stop(req.name, config);
        return create(HostServiceSchema, {
          name: status.name,
          kind: toHostKind(status.kind),
          state: hostStateMap[status.state],
          pid: status.pid,
          lastError: status.lastError,
          lastCheckAt: timestampFromDate(status.lastCheckAt),
        });
      },
    });

    // Container management API (called by the host CLI)
    router.service(ContainerService, {
      async registerContainer(req) {
        const token = stateStore.registerContainer(req.name);
        return create(RegisterContainerResponseSchema, { token });
      },

      async unregisterContainer(req) {
        stateStore.unregisterContainer(req.name);
        return create(UnregisterContainerResponseSchema, {});
      },
    });
  };
}
