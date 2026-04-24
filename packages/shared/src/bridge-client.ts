import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ServicesService } from "./gen/avm/bridge/v1/services_pb.js";
import { EditorService } from "./gen/avm/bridge/v1/editor_pb.js";
import { BrowserService } from "./gen/avm/bridge/v1/browser_pb.js";
import { NotificationService } from "./gen/avm/bridge/v1/notification_pb.js";
import { ReposService } from "./gen/avm/bridge/v1/repos_pb.js";

export { ServicesService } from "./gen/avm/bridge/v1/services_pb.js";
export type {
  ListServicesRequest,
  ListServicesResponse,
  GetServiceRequest,
  StartServiceRequest,
  StopServiceRequest,
  Service,
} from "./gen/avm/bridge/v1/services_pb.js";
export { Kind, State } from "./gen/avm/bridge/v1/services_pb.js";

export { EditorService } from "./gen/avm/bridge/v1/editor_pb.js";
export type {
  OpenFileRequest,
  OpenFileResponse,
} from "./gen/avm/bridge/v1/editor_pb.js";

export { BrowserService } from "./gen/avm/bridge/v1/browser_pb.js";
export type {
  OpenUrlRequest,
  OpenUrlResponse,
} from "./gen/avm/bridge/v1/browser_pb.js";

export { NotificationService } from "./gen/avm/bridge/v1/notification_pb.js";
export type {
  NotifyRequest,
  NotifyResponse,
} from "./gen/avm/bridge/v1/notification_pb.js";
export { NotificationKind } from "./gen/avm/bridge/v1/notification_pb.js";

export { ReposService } from "./gen/avm/bridge/v1/repos_pb.js";
export type {
  GetRepoRequest,
  Repo,
  SymlinkMount,
} from "./gen/avm/bridge/v1/repos_pb.js";

function authInterceptor(token: string): Interceptor {
  return (next) => (req) => {
    req.header.set("Authorization", `Bearer ${token}`);
    return next(req);
  };
}

export function createBridgeClient(port: number, token: string) {
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
    interceptors: [authInterceptor(token)],
  });
  return createClient(ServicesService, transport);
}

export function createBridgeEditorClient(port: number, token: string) {
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
    interceptors: [authInterceptor(token)],
  });
  return createClient(EditorService, transport);
}

export function createBridgeBrowserClient(port: number, token: string) {
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
    interceptors: [authInterceptor(token)],
  });
  return createClient(BrowserService, transport);
}

export function createBridgeNotificationClient(port: number, token: string) {
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
    interceptors: [authInterceptor(token)],
  });
  return createClient(NotificationService, transport);
}

export function createBridgeReposClient(port: number, token: string) {
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
    interceptors: [authInterceptor(token)],
  });
  return createClient(ReposService, transport);
}
