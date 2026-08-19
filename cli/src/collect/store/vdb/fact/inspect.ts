import type { Inspect } from "../../../inspection";
import {
  confirmOpenSearchConnection,
  prepareOpenSearchAccess,
} from "../../../shared/opensearch-access";
import type { VdbConfig } from "../config";
import {
  confirmInspectedVdbTarget,
  confirmVdbTarget,
} from "../configuration";
import type { VdbCommandContext } from "../context";
import type { VdbConfigurationFact, VdbInspectionFacts } from "./model";

function captureReason(ok: boolean, stderr: string, exitCode: number | null): string | undefined {
  return ok ? undefined : stderr.trim().split("\n")[0] || `exit=${exitCode}`;
}

export function makeVdbConfigurationInspect(
  config: VdbConfig,
): Inspect<VdbInspectionFacts, VdbCommandContext> {
  return {
    id: "vdb-configuration",
    run: async (ctx) => {
      const confirmed = config.inspectedTarget
        ? confirmInspectedVdbTarget(config.inspectedTarget)
        : ctx.execTarget
          ? await confirmVdbTarget(ctx.executor, ctx.execTarget, config.capability)
          : { captures: [], reason: "VDB capability 未提供 target" };
      for (const [index, capture] of confirmed.captures.entries()) {
        ctx.bundle.addStep({
          id: `runtime-config-source-${index + 1}`,
          title: "读取目标 Container 声明或运行时配置",
          risk: "observe",
          status: capture.ok ? "ok" : "failed",
          reason: captureReason(capture.ok, capture.stderr, capture.exitCode),
          command: capture.command,
          exitCode: capture.exitCode,
          durationMs: capture.durationMs,
        });
      }
      const execution = {
        status: "collected" as const,
        namespace: confirmed.connection?.source?.namespace ?? ctx.kube.namespace,
        pod: confirmed.connection?.source?.pod ?? ctx.execTarget?.pod,
        container: confirmed.connection?.source?.container ?? ctx.execTarget?.container,
      };
      if (!confirmed.connection) {
        const reason = confirmed.reason ?? "Service 当前未提供有效 VDB 配置，VDB Store 未启用";
        ctx.bundle.fill("runtime-config", { status: "unavailable", reason });
        return {
          execution,
          configuration: { status: "unavailable" as const, reason },
        };
      }
      ctx.connection = confirmed.connection;
      const connection = confirmed.connection;
      const sanitized: VdbConfigurationFact = {
        type: connection.type,
        backend: connection.type === "opensearch" ? "opensearch" : connection.backend,
        store: connection.store,
        configSource: connection.configSource,
        configurationKind: connection.configurationKind,
        configPath: connection.configPath,
        endpoint: connection.type === "opensearch" ? connection.endpoint : undefined,
        username: connection.type === "opensearch" ? connection.username : undefined,
        credentials: connection.type === "opensearch"
          ? connection.username && connection.password ? "configured" : "anonymous-or-incomplete"
          : undefined,
      };
      ctx.bundle.fill("runtime-config", {
        status: "ok",
        output: `${JSON.stringify(sanitized, null, 2)}\n`,
        ext: "json",
      });
      return {
        execution,
        configuration: { status: "collected" as const, ...sanitized },
      };
    },
  };
}

export function makeVdbAccessInspect(
  config: VdbConfig,
): Inspect<VdbInspectionFacts, VdbCommandContext> {
  return {
    id: "vdb-access",
    dependsOn: ["vdb-configuration"],
    run: async (ctx, facts) => {
      if (facts.configuration?.status !== "collected") {
        const reason = facts.configuration?.reason ?? "VDB 配置未确认";
        ctx.bundle.fill("access-preparation", { status: "unavailable", reason });
        return { access: { status: "unavailable", reason } };
      }
      if (ctx.connection?.type !== "opensearch") {
        const backend = ctx.connection?.type === "unsupported"
          ? ctx.connection.backend
          : facts.configuration.backend;
        const reason = `暂不支持 VDB backend '${backend}'；当前探针仅实现 opensearch`;
        ctx.bundle.fill("access-preparation", { status: "unavailable", reason });
        return { access: { status: "unavailable", reason } };
      }
      ctx.openSearchConnection = ctx.connection;
      const confirmation = await confirmOpenSearchConnection({
        endpoint: config.endpoint,
        configuredEndpoint: ctx.connection.endpoint,
        serviceName: config.service,
        kube: ctx.kube,
      }, ctx.log);
      for (const step of confirmation.steps) ctx.bundle.addStep(step);
      if (confirmation.failure) {
        ctx.bundle.fill("access-preparation", {
          status: "failed",
          reason: confirmation.failure.reason,
        });
        return { access: { status: "failed", reason: confirmation.failure.reason } };
      }
      const directCredentials = confirmation.connection?.kind === "direct"
        && confirmation.connection.username
        && confirmation.connection.password;
      const auth = directCredentials
          ? {}
          : ctx.connection.username && ctx.connection.password
            ? { username: ctx.connection.username, password: ctx.connection.password }
            : {};
      const preparation = await prepareOpenSearchAccess({
        connection: confirmation.connection,
        kube: ctx.kube,
        auth,
      }, ctx.log, ctx.search);
      ctx.preparation = preparation;
      for (const step of preparation.steps) ctx.bundle.addStep(step);
      if (preparation.failure || !preparation.search || !preparation.channel) {
        const reason = preparation.failure?.reason ?? "OpenSearch 访问通道不完整";
        ctx.bundle.fill("access-preparation", { status: "failed", reason });
        return { access: { status: "failed", reason } };
      }
      ctx.search = preparation.search;
      ctx.channel = preparation.channel;
      const service = confirmation.connection?.kind === "service"
        ? `${confirmation.connection.service.namespace}/${confirmation.connection.service.name}`
        : undefined;
      const access = {
        backend: "opensearch" as const,
        channel: preparation.channel,
        endpoint: preparation.baseUrl,
        service,
      };
      ctx.bundle.fill("access-preparation", {
        status: "ok",
        output: `${JSON.stringify(access, null, 2)}\n`,
        ext: "json",
      });
      return { access: { status: "collected", ...access } };
    },
  };
}
