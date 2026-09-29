import { clientKey } from "@compforge/harness-common";
import type { ServiceS3DataSource } from "@compforge/doctor-plugin";
import { KubernetesClient } from "@compforge/harness-toolbox/kubernetes/client";
import type { Executor, ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";
import { serviceIdentity } from "@compforge/harness-toolbox/kubernetes/service";
import { S3DataSource, type S3Client, type S3Target } from "@compforge/harness-toolbox/s3";
import { PortForwardTransport } from "@compforge/harness-toolbox/transport";
import type { CommandContext } from "../command";
import type { KubernetesCommandConfig, PodTarget } from "../command/kubernetes-target";
import { borrowServiceClient } from "./client";
import { configuredValue, loadServiceRuntimeConfig } from "./runtime-config";

export interface S3SourceConfig {
  collect: KubernetesCommandConfig;
  service: string;
  capability: ServiceS3DataSource;
  target?: PodTarget;
}
export interface ResolvedS3Configuration {
  target?: S3Target;
  client?: S3Client;
  bucket?: string;
  bucketPrefix?: string;
  source: string;
  captures: ExecResult[];
  reason?: string;
}

/** @why Store diagnostics and object browsing must resolve the same Service connection identity. */
export async function resolveS3Configuration(command: CommandContext, config: S3SourceConfig, executor: Executor): Promise<ResolvedS3Configuration> {
  const capability = config.capability;
  if (capability.source) {
    const client = await borrowServiceClient(command, config.collect, executor, config.service, capability, capability.source);
    return { target: client.target, client: client.access, bucket: client.target.bucket,
      bucketPrefix: client.target.bucketPrefix, source: "plugin", captures: [] };
  }
  const names = capability.environment;
  if (!config.target) throw new Error("S3 DataSource 未提供 Workload 配置来源");
  const complete = (environment: Map<string, string>) => !!(
    configuredValue(environment, names.endpoint) && configuredValue(environment, names.bucket)
    && configuredValue(environment, names.accessKey) && configuredValue(environment, names.secretKey)
  );
  const runtime = await loadServiceRuntimeConfig(executor, config.target, complete);
  if (!complete(runtime.environment)) return {
    source: runtime.source, captures: runtime.captures,
    reason: runtime.reason ?? `Service '${config.service}' 当前未提供完整 S3 endpoint/bucket/credential，S3 Store 未启用`,
  };
  const endpoint = new URL(configuredValue(runtime.environment, names.endpoint)!);
  endpoint.username = ""; endpoint.password = "";
  const style = names.addressStyle ? configuredValue(runtime.environment, names.addressStyle)?.toLowerCase() : undefined;
  return {
    source: runtime.source, captures: runtime.captures,
    bucket: configuredValue(runtime.environment, names.bucket)!,
    bucketPrefix: names.bucketPrefix ? configuredValue(runtime.environment, names.bucketPrefix) : undefined,
    target: {
      endpoint: endpoint.toString(), region: configuredValue(runtime.environment, names.region) ?? "us-east-1",
      credentials: { accessKeyId: configuredValue(runtime.environment, names.accessKey)!,
        secretAccessKey: configuredValue(runtime.environment, names.secretKey)! },
      forcePathStyle: style === "path" || style === "true" || style === undefined,
    },
  };
}

/** Only route TCP; preserve the original Host for SigV4 and TLS. Root clients own disposal. */
export async function prepareS3Access(command: CommandContext, collect: KubernetesCommandConfig, target: S3Target, contributedClient?: S3Client) {
  const endpoint = new URL(target.endpoint);
  endpoint.username = ""; endpoint.password = "";
  if (contributedClient) return { client: contributedClient, channel: "plugin" as const, endpoint: endpoint.toString() };
  const identity = serviceIdentity(endpoint.hostname, collect.kubernetes.namespace);
  let preparedEndpoint = endpoint.toString();
  let channel: "direct" | "service-port-forward" = "direct";
  let route: ConstructorParameters<typeof S3DataSource>[2];
  if (identity) {
    const kube = { namespace: identity.namespace, kubeconfig: collect.kubernetes.kubeconfig, context: collect.kubernetes.context };
    const key = clientKey("kubernetes", kube);
    const kubernetes = await command.clients.get({ clientKey: key,
      createClient: (_clients, signal) => new KubernetesClient(kube, signal) });
    const port = endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80;
    const mapped = await kubernetes.forward(kube.namespace, { host: endpoint.hostname, port });
    if (mapped.host !== endpoint.hostname || mapped.port !== port) {
      const local = new URL(endpoint); local.hostname = mapped.host; local.port = String(mapped.port);
      preparedEndpoint = local.toString();
    }
    route = { key, transport: new PortForwardTransport(remote => kubernetes.forward(kube.namespace, remote)) };
    channel = "service-port-forward";
  }
  const client = await command.clients.get(new S3DataSource(target, {
    concurrency: 4, connectTimeoutMs: 10_000, requestTimeoutMs: 10_000,
  }, route));
  return { client, channel, endpoint: preparedEndpoint };
}
