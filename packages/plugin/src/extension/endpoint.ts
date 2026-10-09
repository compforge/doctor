import type { RegisteredExtension } from "./index";
import { validateServiceEndpoint, type ServiceEndpoint } from "../service";

/** Network-backed kinds declare a transport target independently of Service identity. */
export function requireExtensionEndpoint(extension: RegisteredExtension): ServiceEndpoint {
  const endpoint = (extension as RegisteredExtension & { endpoint?: ServiceEndpoint }).endpoint;
  validateServiceEndpoint(endpoint, `${extension.id} ${extension.kind}`);
  return endpoint;
}
