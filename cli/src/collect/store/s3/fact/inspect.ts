import type { ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";
import { inspectS3Provider } from "../../../../infra/object-store";
import { resolveS3Configuration, prepareS3Access } from "../../../../datasource/s3";
import type { Inspect } from "../../../inspection";
import type { S3CommandContext } from "../context";
import type { S3InspectionFacts } from "./model";
import { collectedFact, failedFact, unavailableFact } from "../../../protocol";

function captureReason(capture: ExecResult): string | undefined {
  return capture.ok ? undefined : capture.stderr.trim().split("\n")[0] || `exit=${capture.exitCode}`;
}

export function makeS3ConfigurationInspect(): Inspect<S3InspectionFacts, S3CommandContext> {
  return { id: "s3-configuration", run: async ctx => {
    const resolved = await resolveS3Configuration(ctx.command, { ...ctx.config, capability: ctx.capability }, ctx.executor);
    for (const [index, capture] of resolved.captures.entries()) ctx.bundle.addStep({
      id: `s3-config-source-${index + 1}`, title: "读取 Service Pod 声明或运行时 S3 配置", risk: "observe",
      status: capture.ok ? "ok" : "failed", reason: captureReason(capture), command: capture.command,
      exitCode: capture.exitCode, durationMs: capture.durationMs,
    });
    if (!resolved.target || !resolved.bucket) {
      const reason = resolved.reason ?? "S3 配置未确认";
      ctx.bundle.fill("runtime-config", { status: "unavailable", reason });
      return { configuration: unavailableFact("store.s3.configuration", "s3-configuration", reason) };
    }
    ctx.target = resolved.target;
    ctx.client = resolved.client;
    ctx.originalEndpoint = new URL(resolved.target.endpoint);
    ctx.originalEndpoint.username = ""; ctx.originalEndpoint.password = "";
    ctx.serviceBucket = resolved.bucket; ctx.servicePrefix = resolved.bucketPrefix;
    ctx.inventoryPrefix = ctx.config.s3Prefix ?? "";
    const configuration = { backend: ctx.capability.backend, endpoint: ctx.originalEndpoint.toString(),
      bucket: ctx.serviceBucket, bucketPrefix: ctx.servicePrefix, region: resolved.target.region,
      addressStyle: resolved.target.forcePathStyle ? "path" as const : "virtual" as const,
      credentials: "configured" as const, source: resolved.source };
    ctx.bundle.fill("runtime-config", { status: "ok", output: JSON.stringify(configuration), ext: "json" });
    return { configuration: collectedFact("store.s3.configuration", "s3-configuration", configuration) };
  } };
}

export function makeS3AccessInspect(): Inspect<S3InspectionFacts, S3CommandContext> {
  return { id: "s3-access", dependsOn: ["s3-configuration"], run: async (ctx, facts) => {
    if (facts.configuration?.status !== "collected" || !ctx.originalEndpoint || !ctx.target) {
      const reason = facts.configuration?.status === "collected" ? "S3 endpoint 未解析" : facts.configuration?.reason ?? "S3 配置未确认";
      ctx.bundle.fill("access-preparation", { status: "unavailable", reason });
      return { access: unavailableFact("store.s3.access", "s3-access", reason) };
    }
    try {
      const prepared = await prepareS3Access(ctx.command, ctx.config.collect, ctx.target, ctx.capability.source ? ctx.client : undefined);
      ctx.client = prepared.client; ctx.preparedEndpoint = prepared.endpoint;
      const access = { channel: prepared.channel, endpoint: prepared.endpoint };
      ctx.bundle.fill("access-preparation", { status: "ok", output: JSON.stringify(access), ext: "json" });
      return { access: collectedFact("store.s3.access", "s3-access", access) };
    } catch (error) {
      const reason = `准备 S3 访问通道失败：${error instanceof Error ? error.message : String(error)}`;
      ctx.bundle.fill("access-preparation", { status: "failed", reason });
      return { access: failedFact("store.s3.access", "s3-access", reason) };
    }
  } };
}

export function makeS3ProviderInspect(): Inspect<S3InspectionFacts, S3CommandContext> {
  return {
    id: "s3-provider",
    dependsOn: ["s3-access"],
    run: async (ctx, facts) => {
      if (ctx.capability.source) {
        // Provider-specific HTTP probes cannot bypass a contributed client's transport/access policy.
        const reason = "Plugin DataSource 仅提供 S3 协议访问，不探测额外的 Provider HTTP 接口";
        ctx.bundle.fill("provider-detection", { status: "unavailable", reason });
        return { provider: unavailableFact("store.s3.provider", "s3-provider", reason) };
      }
      if (facts.access?.status !== "collected" || !ctx.preparedEndpoint) {
        const reason = facts.access && facts.access.status !== "collected"
          ? facts.access.reason
          : "S3 访问通道未就绪";
        ctx.bundle.fill("provider-detection", { status: "unavailable", reason });
        return { provider: unavailableFact("store.s3.provider", "s3-provider", reason) };
      }
      const provider = await inspectS3Provider({
        endpoint: ctx.preparedEndpoint,
        credentials: ctx.target
          ? { accessKey: ctx.target.credentials.accessKeyId, secretKey: ctx.target.credentials.secretAccessKey }
          : undefined,
      });
      ctx.bundle.fill("provider-detection", {
        status: "ok",
        output: `${JSON.stringify(provider, null, 2)}\n`,
        ext: "json",
      });
      return { provider: collectedFact("store.s3.provider", "s3-provider", provider) };
    },
  };
}
