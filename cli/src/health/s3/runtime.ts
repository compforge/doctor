import { HttpClient } from "@compforge/harness-toolbox/http";
import { S3Client } from "@compforge/harness-toolbox/s3";
import { DirectTransport, Transport } from "@compforge/harness-toolbox/transport";
import { serviceDataSources } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../../command";
import type { KubernetesCommandConfig } from "../../command/kubernetes-target";
import { resolveS3Configuration } from "../../datasource/s3";
import { resolveDataSourceTarget } from "../../datasource/workload";
import { diagnosticMessage } from "../../command/diagnostic";
import { resolveApprovalGate } from "../../terminal/approval";
import { useLogger } from "../../terminal/log";
import type { HealthProvider } from "../extensions";
import { supplementS3Connectivity } from "./connectivity";
import { checkS3ReadWrite, type S3HealthCheck } from "./probe";

export async function checkHealthS3(provider: HealthProvider, command: CommandContext,
  collect: KubernetesCommandConfig, executor: Executor, checkpoint: (checks: S3HealthCheck[]) => void): Promise<S3HealthCheck[]> {
  const results: S3HealthCheck[] = [];
  for (const reference of provider.s3Sources ?? []) {
    const result: S3HealthCheck = { ...reference, executionLocation: "doctor-host", channel: "direct",
      startedAt: new Date().toISOString(), status: "unavailable", steps: [] };
    results.push(result);
    let client: S3Client | undefined;
    let http: HttpClient | undefined;
    try {
      command.signal.throwIfAborted();
      const capability = serviceDataSources(command.plugin.services, reference.service, "s3").find(source => source.id === reference.dataSource);
      if (!capability || capability.kind !== "s3") throw new Error("S3 DataSource 未注册");
      const target = capability.source ? undefined : await resolveDataSourceTarget({
        service: command.plugin.services.find(reference.service)!, executor, namespace: collect.kubernetes.namespace,
        interactive: false, commandContext: command,
        selection: { candidateRole: "配置来源", purpose: "读取 S3 读写检查的连接配置", effect: "下载请求从 Doctor host 直接发起" },
      });
      const resolved = await resolveS3Configuration(command, { collect, service: reference.service, capability, target }, executor);
      if (!resolved.target || !resolved.bucket) throw new Error(resolved.reason ?? "S3 endpoint 或 bucket 配置缺失");
      result.endpoint = new URL(resolved.target.endpoint).toString(); result.bucket = resolved.bucket;
      result.region = resolved.target.region; result.addressStyle = resolved.target.forcePathStyle === false ? "virtual-hosted" : "path";
      // Own this bounded client's lifetime through cleanup, even when the command's root clients are cancelled.
      const transport = new Transport([new DirectTransport()]);
      client = new S3Client(resolved.target, transport, {
        concurrency: 1, connectTimeoutMs: 10_000, requestTimeoutMs: 10_000,
      });
      await client.initialize();
      await checkS3ReadWrite({ result, bucket: resolved.bucket, prefix: resolved.bucketPrefix, signal: command.signal,
        secrets: Object.values(resolved.target.credentials).filter((value): value is string => typeof value === "string"),
        client, download: async (url, signal) => {
          http = new HttpClient({ endpoint: new URL(url).origin, ca: resolved.target!.ca }, transport, {
            concurrency: 1, connectTimeoutMs: 10_000, requestTimeoutMs: 10_000, maxResponseBytes: 16_384,
          });
          return http.request(url, { signal });
        }, approve: resolveApprovalGate({ yes: command.options.yes }), checkpoint: () => checkpoint(results) });
      await supplementS3Connectivity(result, resolved.target, command.signal);
    } catch (error) {
      result.status = command.signal.aborted ? "cancelled" : "unavailable";
      result.reason = diagnosticMessage(error);
    } finally {
      await http?.dispose();
      await client?.dispose();
      result.finishedAt ??= new Date().toISOString();
      useLogger("health").info(`${reference.service}/${reference.dataSource}: S3 读写检查 ${result.status}`);
      checkpoint(results);
    }
  }
  return results;
}
