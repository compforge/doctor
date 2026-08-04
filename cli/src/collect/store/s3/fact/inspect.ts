import { KubectlExecutor, type ExecResult } from "../../../../infra/k8s/executor";
import { serviceIdentity } from "../../../../infra/k8s/service";
import { ServicePortForwarder } from "../../../../infra/k8s/service-port-forward";
import { inspectS3Provider, type S3Target } from "../../../../infra/object-store";
import type { Inspect } from "../../../inspection";
import { configuredValue, loadServiceRuntimeConfig } from "../../runtime-config";
import type { S3CollectContext } from "../context";
import type { S3InspectionFacts } from "./model";

function captureReason(capture: ExecResult): string | undefined {
  return capture.ok ? undefined : capture.stderr.trim().split("\n")[0] || `exit=${capture.exitCode}`;
}

export function makeS3ConfigurationInspect(): Inspect<S3InspectionFacts, S3CollectContext> {
  return {
    id: "s3-configuration",
    run: async (ctx) => {
      const names = ctx.capability.environment;
      const complete = (environment: Map<string, string>) => !!(
        configuredValue(environment, names.endpoint)
        && configuredValue(environment, names.bucket)
        && configuredValue(environment, names.accessKey)
        && configuredValue(environment, names.secretKey)
      );
      const runtime = await loadServiceRuntimeConfig(ctx.executor, ctx.config.target, complete);
      for (const [index, capture] of runtime.captures.entries()) {
        ctx.bundle.addStep({
          id: `s3-config-source-${index + 1}`,
          title: "读取 Service Pod 声明或运行时 S3 配置",
          risk: "observe",
          status: capture.ok ? "ok" : "failed",
          reason: captureReason(capture),
          command: capture.command,
          exitCode: capture.exitCode,
          durationMs: capture.durationMs,
        });
      }
      if (!complete(runtime.environment)) {
        const reason = runtime.reason
          ?? `Service '${ctx.config.service}' 当前未提供完整 S3 endpoint/bucket/credential，S3 Store 未启用`;
        ctx.bundle.fill("runtime-config", { status: "unavailable", reason });
        return { configuration: { status: "unavailable", reason } };
      }
      const originalEndpoint = new URL(configuredValue(runtime.environment, names.endpoint)!);
      originalEndpoint.username = "";
      originalEndpoint.password = "";
      const addressStyle = names.addressStyle
        ? configuredValue(runtime.environment, names.addressStyle)?.toLowerCase()
        : undefined;
      const bucketPrefix = names.bucketPrefix
        ? configuredValue(runtime.environment, names.bucketPrefix)
        : undefined;
      const target: S3Target = {
        endpoint: originalEndpoint.toString(),
        bucket: configuredValue(runtime.environment, names.bucket)!,
        region: configuredValue(runtime.environment, names.region) ?? "us-east-1",
        accessKey: configuredValue(runtime.environment, names.accessKey)!,
        secretKey: configuredValue(runtime.environment, names.secretKey)!,
        pathStyle: addressStyle === "path" || addressStyle === "true" || addressStyle === undefined,
      };
      ctx.originalEndpoint = originalEndpoint;
      ctx.target = target;
      ctx.inventoryPrefix = ctx.config.s3Prefix ?? "";
      ctx.serviceBucket = target.bucket;
      ctx.servicePrefix = bucketPrefix;
      const configuration = {
        backend: ctx.capability.backend,
        endpoint: originalEndpoint.toString(),
        bucket: target.bucket,
        bucketPrefix,
        region: target.region,
        addressStyle: target.pathStyle ? "path" as const : "virtual" as const,
        credentials: "configured" as const,
        source: runtime.source,
      };
      ctx.bundle.fill("runtime-config", {
        status: "ok",
        output: `${JSON.stringify({ status: "collected", ...configuration }, null, 2)}\n`,
        ext: "json",
      });
      return { configuration: { status: "collected", ...configuration } };
    },
  };
}

export function makeS3AccessInspect(): Inspect<S3InspectionFacts, S3CollectContext> {
  return {
    id: "s3-access",
    dependsOn: ["s3-configuration"],
    run: async (ctx, facts) => {
      if (facts.configuration?.status !== "collected" || !ctx.originalEndpoint) {
        const reason = facts.configuration?.status === "collected"
          ? "S3 endpoint 未解析"
          : facts.configuration?.reason ?? "S3 配置未确认";
        ctx.bundle.fill("access-preparation", { status: "unavailable", reason });
        return { access: { status: "unavailable", reason } };
      }
      try {
        const endpoint = ctx.originalEndpoint;
        const identity = serviceIdentity(endpoint.hostname, ctx.config.collect.kubernetes.namespace);
        let preparedEndpoint = endpoint.toString();
        let channel: "direct" | "service-port-forward" = "direct";
        if (identity) {
          const executor = new KubectlExecutor({
            namespace: identity.namespace,
            kubeconfig: ctx.config.collect.kubernetes.kubeconfig,
            context: ctx.config.collect.kubernetes.context,
          });
          ctx.forwarder = await ServicePortForwarder.create(executor, {
            namespace: identity.namespace,
            kubeconfig: ctx.config.collect.kubernetes.kubeconfig,
            context: ctx.config.collect.kubernetes.context,
          });
          const port = endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80;
          const mapped = await ctx.forwarder.forward({ host: endpoint.hostname, port });
          if (mapped.host !== endpoint.hostname || mapped.port !== port) {
            const local = new URL(endpoint);
            local.hostname = mapped.host;
            local.port = String(mapped.port);
            preparedEndpoint = local.toString();
          }
          channel = "service-port-forward";
        }
        ctx.preparedEndpoint = preparedEndpoint;
        const access = { channel, endpoint: preparedEndpoint };
        ctx.bundle.fill("access-preparation", {
          status: "ok",
          output: `${JSON.stringify(access, null, 2)}\n`,
          ext: "json",
        });
        return { access: { status: "collected", ...access } };
      } catch (error) {
        const reason = `准备 S3 访问通道失败：${error instanceof Error ? error.message : String(error)}`;
        ctx.bundle.fill("access-preparation", { status: "failed", reason });
        return { access: { status: "failed", reason } };
      }
    },
  };
}

export function makeS3ProviderInspect(): Inspect<S3InspectionFacts, S3CollectContext> {
  return {
    id: "s3-provider",
    dependsOn: ["s3-access"],
    run: async (ctx, facts) => {
      if (facts.access?.status !== "collected" || !ctx.preparedEndpoint) {
        const reason = facts.access && facts.access.status !== "collected"
          ? facts.access.reason
          : "S3 访问通道未就绪";
        ctx.bundle.fill("provider-detection", { status: "unavailable", reason });
        return { provider: { status: "unavailable", reason } };
      }
      const provider = await inspectS3Provider({
        endpoint: ctx.preparedEndpoint,
        credentials: ctx.target
          ? { accessKey: ctx.target.accessKey, secretKey: ctx.target.secretKey }
          : undefined,
      });
      ctx.bundle.fill("provider-detection", {
        status: "ok",
        output: `${JSON.stringify(provider, null, 2)}\n`,
        ext: "json",
      });
      return { provider: { status: "collected", ...provider } };
    },
  };
}
