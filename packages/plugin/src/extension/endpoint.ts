import type { RegisteredExtension } from "./index";
import type { ServiceEndpoint } from "../service";

/** Network-backed kinds declare a transport target independently of Service identity. */
export function requireExtensionEndpoint(extension: RegisteredExtension): ServiceEndpoint {
  const endpoint = (extension as RegisteredExtension & { endpoint?: ServiceEndpoint }).endpoint;
  if (!endpoint || typeof endpoint.host !== "string" || !endpoint.host.trim()
    || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    throw new Error(`${extension.id}: invalid ${extension.kind} endpoint`);
  }
  return endpoint;
}
