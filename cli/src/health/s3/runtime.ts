import type { HealthInteraction } from "../interaction";
import { HttpClient } from "@compforge/harness-toolbox/http";
import { S3Client } from "@compforge/harness-toolbox/s3";
import { DirectTransport, Transport } from "@compforge/harness-toolbox/transport";
import { serviceDataSources, type PluginDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandInputError, type CommandContext } from "../../command";
import type { KubernetesCommandConfig } from "../../command/kubernetes-target";
import { resolveS3Configuration } from "../../datasource/s3";
import { resolveDataSourceTarget } from "../../datasource/workload";
import { diagnosticMessage } from "../../command/diagnostic";
import { canPrompt } from "../../terminal/parameters";
import { resolveApprovalGate } from "../../terminal/approval";
import { useLogger } from "../../terminal/log";
import type { HealthProvider } from "../extensions";
import { supplementS3Connectivity } from "./connectivity";
import { checkS3ReadWrite, type S3HealthCheck } from "./probe";

export interface S3HealthSourceSelection {
  pod?: string;
  container?: string;
}

/** @spec Explicit instance selectors apply to one configuration-owning Service, never unrelated Services in a batch. */
export function validateHealthS3SourceSelection(providers: readonly HealthProvider[], plugin: PluginDefinition, selection: S3HealthSourceSelection): void {
  if (selection.pod === undefined && selection.container === undefined) return;
  const owners = new Set(providers.flatMap(provider => (provider.s3Sources ?? []).flatMap(reference => {
    const source = serviceDataSources(plugin.services, reference.service, "s3").find(source => source.id === reference.dataSource);
    return source?.kind === "s3" && !source.source ? [plugin.services.find(reference.service)!.name] : [];
  })));
  if (owners.size !== 1) throw new CommandInputError(
    "health --pod/--container 仅适用于一个从 Workload 读取 S3 配置的 Service；请用 --service 和 --scope deps 限定检查范围",
  );
}

/**
 * @spec One Health execution probes each canonical Service/DataSource once, including failed and cancelled checks.
 * @spec Concurrent consumers share the in-flight operation through cleanup; separate sessions never share results.
 */
export class S3HealthSession {
  private readonly checks = new Map<string, Promise<S3HealthCheck>>();

  constructor(private readonly command: CommandContext, private readonly collect: KubernetesCommandConfig,
    private readonly executor: Executor, private readonly selection: S3HealthSourceSelection & { interactive?: boolean; interaction?: HealthInteraction } = {}) {}

  async check(provider: HealthProvider, checkpoint: (checks: S3HealthCheck[]) => void): Promise<S3HealthCheck[]> {
    const results: S3HealthCheck[] = [];
    for (const reference of provider.s3Sources ?? []) {
      if (this.selection.interaction?.stopped || this.command.signal.aborted) break;
      const service = this.command.plugin.services.find(reference.service)?.name ?? reference.service;
      const dataSource = reference.dataSource;
      if (results.some(check => check.service === service && check.dataSource === dataSource)) continue;
      const key = JSON.stringify([service, dataSource]);
      let pending = this.checks.get(key);
      if (!pending) {
        const result: S3HealthCheck = { service, dataSource, executionLocation: "doctor-host", channel: "direct",
          startedAt: new Date().toISOString(), status: "unavailable", steps: [] };
        results.push(result);
        pending = Promise.resolve().then(() => checkS3Source(result, this.command, this.collect, this.executor,
          () => checkpoint(results), this.selection));
        this.checks.set(key, pending);
        await pending;
      } else {
        results.push(await pending);
        useLogger("health").debug(`${service}/${dataSource}: 复用本次 S3 读写检查结果`);
      }
      checkpoint(results);
    }
    return results;
  }
}

async function checkS3Source(result: S3HealthCheck, command: CommandContext,
  collect: KubernetesCommandConfig, executor: Executor, checkpoint: () => void,
  selection: S3HealthSourceSelection & { interactive?: boolean; interaction?: HealthInteraction }): Promise<S3HealthCheck> {
  let client: S3Client | undefined;
  let http: HttpClient | undefined;
  try {
    command.signal.throwIfAborted();
    const capability = serviceDataSources(command.plugin.services, result.service, "s3").find(source => source.id === result.dataSource);
    if (!capability || capability.kind !== "s3") throw new Error("S3 DataSource 未注册");
    const target = capability.source ? undefined : await resolveDataSourceTarget({
      service: command.plugin.services.find(result.service)!, executor, namespace: collect.kubernetes.namespace,
      pod: selection.pod, container: selection.container,
      interactive: !command.options.yes && canPrompt(selection), commandContext: command,
      selection: { candidateRole: "配置来源", purpose: `读取 Service '${result.service}' 的 S3 读写检查连接配置`, effect: "下载请求从 Doctor host 直接发起" },
    });
    if (!capability.source && !target) {
      result.status = "cancelled"; result.reason = "已取消 S3 配置来源选择"; return result;
    }
    const resolved = await resolveS3Configuration(command, { collect, service: result.service, capability, target }, executor);
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
      }, approve: selection.interaction?.approve ?? resolveApprovalGate({ yes: command.options.yes }), checkpoint });
    if (selection.interaction?.stopped && result.status === "skipped") {
      result.status = "not-run"; result.reason = "用户结束巡检，未执行 S3 读写检查";
    }
    await supplementS3Connectivity(result, resolved.target, command.signal);
  } catch (error) {
    result.status = command.signal.aborted ? "cancelled" : "unavailable";
    result.reason = diagnosticMessage(error);
  } finally {
    await http?.dispose();
    await client?.dispose();
    result.finishedAt ??= new Date().toISOString();
    useLogger("health").info(`${result.service}/${result.dataSource}: S3 读写检查 ${result.status}`);
    checkpoint();
  }
  return result;
}
