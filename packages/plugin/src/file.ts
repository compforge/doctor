import { clientKey, type FileClient, type FileDataSource } from "@compforge/harness-common";
import type { CapabilityAccess } from "./kubernetes";
import type { PluginClientContext, PluginDataSource } from "./context";

export interface ServiceFileTarget {
  namespace: string;
  pod: string;
  container: string;
}

export interface ServiceFileClient extends FileClient {
  readonly target: ServiceFileTarget;
}

/** Static declaration; target discovery and reads share the root client's lifecycle. */
export interface ServiceFileDataSource extends PluginDataSource<ServiceFileClient>, Pick<FileDataSource, "paths" | "description"> {
  readonly workload: string;
  readonly access: CapabilityAccess;
}

/** File sources are contributed directly, without a Store id/kind/source wrapper. */
export function isFileDataSource(value: unknown): value is ServiceFileDataSource {
  return !!value && typeof value === "object" && "paths" in value && "createClient" in value;
}

/**
 * @spec Catalog loading performs no I/O; initialize resolves one Pod/container and each read acquires the declared group once.
 * @why Doctor injects scoped access; Quality Harness owns bounded file I/O and root client cleanup.
 * @see {@link cli/docs/commands/inspect.md}
 */
export function fileDataSource(paths: readonly string[], options: {
  workload: string;
  description?: string;
  access: CapabilityAccess;
  resolve(context: PluginClientContext): Promise<ServiceFileTarget>;
}): ServiceFileDataSource {
  if (!paths.length || paths.some(path => typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) || new Set(paths).size !== paths.length) {
    throw new Error("File source paths must be nonempty, distinct absolute Pod paths");
  }
  paths = Object.freeze([...paths]);
  return {
    paths, workload: options.workload, description: options.description, access: options.access,
    clientKey: clientKey("plugin-file", { paths, workload: options.workload }),
    createClient: context => {
      let target: ServiceFileTarget | undefined;
      return {
        get target() {
          if (!target) throw new Error(`File source is not initialized: ${paths.join(", ")}`);
          return target;
        },
        async initialize() {
          const resolved = await options.resolve(context);
          context.signal.throwIfAborted();
          if (![resolved.namespace, resolved.pod, resolved.container].every(value => typeof value === "string" && value.trim())) {
            throw new Error(`File source target requires namespace, Pod and Container: ${paths.join(", ")}`);
          }
          target = { ...resolved };
        },
        async read(limits) {
          context.signal.throwIfAborted();
          if (!target) throw new Error(`File source is not initialized: ${paths.join(", ")}`);
          return context.infra.kubernetes.inNamespace(target.namespace).readFiles(
            { pod: target.pod, container: target.container }, paths, limits);
        },
        async dispose() { target = undefined; },
      };
    },
  };
}
