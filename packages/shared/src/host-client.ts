import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ContainerService } from "./gen/avm/host/v1/containers_pb.js";
import { ServicesService } from "./gen/avm/host/v1/services_pb.js";
import { PortForwardService } from "./gen/avm/host/v1/ports_pb.js";

export { ContainerService } from "./gen/avm/host/v1/containers_pb.js";
export type {
  RegisterContainerRequest,
  RegisterContainerResponse,
  UnregisterContainerRequest,
  UnregisterContainerResponse,
} from "./gen/avm/host/v1/containers_pb.js";

export { ServicesService } from "./gen/avm/host/v1/services_pb.js";
export type {
  ListServicesRequest,
  ListServicesResponse,
  GetServiceRequest,
  StartServiceRequest,
  StopServiceRequest,
  Service,
} from "./gen/avm/host/v1/services_pb.js";
export { Kind, State } from "./gen/avm/host/v1/services_pb.js";

export { PortForwardService } from "./gen/avm/host/v1/ports_pb.js";
export type {
  ListPortForwardsRequest,
  ListPortForwardsResponse,
  StopPortForwardRequest,
  PortForward,
} from "./gen/avm/host/v1/ports_pb.js";

function authInterceptor(hostSecret: string): Interceptor {
  return (next) => (req) => {
    req.header.set("Authorization", `Bearer ${hostSecret}`);
    return next(req);
  };
}

function createHostTransport(port: number, hostSecret: string) {
  return createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
    interceptors: [authInterceptor(hostSecret)],
  });
}

export function createHostContainerClient(port: number, hostSecret: string) {
  return createClient(ContainerService, createHostTransport(port, hostSecret));
}

export function createHostServicesClient(port: number, hostSecret: string) {
  return createClient(ServicesService, createHostTransport(port, hostSecret));
}

export function createHostPortForwardClient(port: number, hostSecret: string) {
  return createClient(PortForwardService, createHostTransport(port, hostSecret));
}
