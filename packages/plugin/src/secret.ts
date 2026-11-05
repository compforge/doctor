import { clientKey } from "@compforge/harness-common";
import { KubernetesSecretClient, secretKeys, type KubernetesSecretTarget, type KubernetesSecretRead } from "@compforge/harness-toolbox/kubernetes/secret-datasource";
import type { PluginClientContext, PluginDataSource } from "./context";
import type { CapabilityAccess } from "./kubernetes";

export type ServiceSecretTarget = KubernetesSecretTarget;
export type ServiceSecretRead = KubernetesSecretRead;
export type ServiceSecretClient = Pick<KubernetesSecretClient, "target" | "read" | "initialize" | "dispose">;

export interface ServiceSecretDataSource extends PluginDataSource<ServiceSecretClient> {
  readonly kind: "secret";
  readonly id: string;
  readonly keys: readonly string[];
  readonly description?: string;
  readonly access: CapabilityAccess;
}

export function isSecretDataSource(value: unknown): value is ServiceSecretDataSource {
  return !!value && typeof value === "object" && "kind" in value && value.kind === "secret";
}

/**
 * @spec Service owns discovery and key selection; Toolbox owns Secret acquisition and decoding.
 * @why Inject the host's guarded Kubernetes view so shared acquisition cannot bypass capability access.
 * @see {@link cli/docs/commands/inspect.md}
 */
export function secretDataSource(id: string, options: {
  keys: readonly string[];
  description?: string;
  access: CapabilityAccess;
  resolve(context: PluginClientContext): Promise<ServiceSecretTarget>;
}): ServiceSecretDataSource {
  if (!id.trim()) throw new Error("Secret source id must be nonempty");
  const keys = secretKeys(options.keys);
  return {
    kind: "secret", id, keys, description: options.description, access: options.access,
    clientKey: clientKey("plugin-secret", { id, keys }),
    createClient: context => new KubernetesSecretClient(keys, context.signal, async () => ({
      target: await options.resolve(context),
      access: { get: ({ namespace, ...ref }, readOptions) => context.infra.kubernetes
        .inNamespace(namespace!).get(ref, readOptions) },
    })),
  };
}
