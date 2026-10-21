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
export interface ServiceFileDataSource extends PluginDataSource<ServiceFileClient>, Pick<FileDataSource, "path" | "description"> {
  readonly workload: string;
  readonly access: CapabilityAccess;
}

/** File sources are contributed directly, without a Store id/kind/source wrapper. */
export function isFileDataSource(value: unknown): value is ServiceFileDataSource {
  return !!value && typeof value === "object" && "path" in value && "createClient" in value;
}

/**
 * @spec Catalog loading performs no I/O; initialize resolves one explicit Pod/container and every read observes fresh bytes.
 * @why Doctor injects scoped access; Quality Harness owns bounded file I/O and root client cleanup.
 * @see {@link cli/docs/commands/inspect.md}
 */
export function fileDataSource(path: string, options: {
  workload: string;
  description?: string;
  access: CapabilityAccess;
  resolve(context: PluginClientContext): Promise<ServiceFileTarget>;
}): ServiceFileDataSource {
  return {
    path, workload: options.workload, description: options.description, access: options.access,
    clientKey: clientKey("plugin-file", { path, workload: options.workload }),
    createClient: context => {
      let target: ServiceFileTarget | undefined;
      return {
        get target() {
          if (!target) throw new Error(`File source is not initialized: ${path}`);
          return target;
        },
        async initialize() {
          const resolved = await options.resolve(context);
          context.signal.throwIfAborted();
          if (![resolved.namespace, resolved.pod, resolved.container].every(value => typeof value === "string" && value.trim())) {
            throw new Error(`File source target requires namespace, Pod and Container: ${path}`);
          }
          target = { ...resolved };
        },
        async read(limits) {
          context.signal.throwIfAborted();
          if (!target) throw new Error(`File source is not initialized: ${path}`);
          return context.infra.kubernetes.inNamespace(target.namespace).readFile(
            { pod: target.pod, container: target.container }, path, limits);
        },
        async dispose() { target = undefined; },
      };
    },
  };
}
