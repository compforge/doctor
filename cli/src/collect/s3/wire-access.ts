import { clientKey } from "@compforge/harness-common";
import type { ServiceS3DataSource } from "@compforge/doctor-plugin";
import { HttpClient } from "@compforge/harness-toolbox/http";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { serviceIdentity } from "@compforge/harness-toolbox/kubernetes/service";
import { DirectTransport, PortForwardTransport, type TcpTransport } from "@compforge/harness-toolbox/transport";
import type { S3Client, S3Target } from "@compforge/harness-toolbox/s3";
import type { CommandContext } from "../../command";
import type { KubernetesCommandConfig } from "../../command/kubernetes-target";
import { borrowServiceClient } from "../../datasource/client";
import { S3Wire } from "./chunk";

/** Resolve bucket addressing with the source SDK. No presigned query is transmitted or recorded. */
export async function prepareWire(context: CommandContext, collect: KubernetesCommandConfig, executor: Executor,
  service: string, capability: ServiceS3DataSource, target: S3Target, client: S3Client,
  transport: TcpTransport | undefined, bucket: string, signal: AbortSignal) {
  const marker = "doctor-inspect-address";
  const base = new URL(await client.presignGetObject(bucket, marker, { expiresIn: 60, signal }));
  const endpoint = new URL(target.endpoint);
  if (base.protocol !== endpoint.protocol || base.port !== endpoint.port ||
      (base.hostname !== endpoint.hostname && base.hostname !== bucket + "." + endpoint.hostname) ||
      !base.pathname.endsWith("/" + marker)) throw new Error("Unexpected S3 bucket address");
  base.search = "";
  base.pathname = base.pathname.slice(0, -marker.length);
  const identity = serviceIdentity(endpoint.hostname, collect.kubernetes.namespace);
  const httpTarget = { endpoint: base.origin, ca: target.ca };
  const limits = { concurrency: 1, connectTimeoutMs: 10_000, requestTimeoutMs: 30_000, maxResponseBytes: 64 * 1024 };
  const key = clientKey("s3-inspect-http", { httpTarget, route: endpoint.host, namespace: collect.kubernetes.namespace, limits });
  const http = capability.source
    ? await borrowServiceClient(context, collect, executor, service, capability, {
      clientKey: key, createClient: ctx => new HttpClient(httpTarget,
        identity ? new PortForwardTransport(dial => ctx.infra.kubernetes.inNamespace(identity.namespace)
          .portForward({ ...dial, host: endpoint.hostname })) : new DirectTransport(), limits, { signal: ctx.signal }),
    })
    : await context.clients.get({ clientKey: key, createClient: (_clients, rootSignal) =>
      new HttpClient(httpTarget, identity && transport
        ? new PortForwardTransport((dial, attempt) => transport.connect({ ...dial, host: endpoint.hostname }, attempt))
        : new DirectTransport(), limits, { signal: rootSignal }) });
  return new S3Wire(http, base, target);
}
