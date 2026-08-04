import { MysqlDatabase, parseMysqlEnvTarget } from "../../../../infra/database/mysql";
import type { ExecResult } from "../../../../infra/k8s/executor";
import { ServicePortForwarder } from "../../../../infra/k8s/service-port-forward";
import type { Inspect } from "../../../inspection";
import { configuredValue, loadServiceRuntimeConfig } from "../../runtime-config";
import type { DbCollectContext } from "../context";
import type { DbInspectionFacts } from "./model";

function environmentText(environment: Map<string, string>): string {
  return [...environment].map(([name, value]) => `${name}=${value}`).join("\n");
}

function captureReason(capture: ExecResult): string | undefined {
  return capture.ok ? undefined : capture.stderr.trim().split("\n")[0] || `exit=${capture.exitCode}`;
}

export function makeDbConfigurationInspect(): Inspect<DbInspectionFacts, DbCollectContext> {
  return {
    id: "db-configuration",
    run: async (ctx) => {
      const prefix = ctx.capability.envPrefix;
      const required = (environment: Map<string, string>) => !!(
        configuredValue(environment, `${prefix}_HOST`)
        && (configuredValue(environment, `${prefix}_DATABASE`) || configuredValue(environment, `${prefix}_NAME`))
        && (configuredValue(environment, `${prefix}_USERNAME`) || configuredValue(environment, `${prefix}_USER`))
        && configuredValue(environment, `${prefix}_PASSWORD`)
      );
      const runtime = await loadServiceRuntimeConfig(ctx.executor, ctx.config.target, required);
      for (const [index, capture] of runtime.captures.entries()) {
        ctx.bundle.addStep({
          id: `db-config-source-${index + 1}`,
          title: "读取 Service Pod 声明或运行时 DB 配置",
          risk: "observe",
          status: capture.ok ? "ok" : "failed",
          reason: captureReason(capture),
          command: capture.command,
          exitCode: capture.exitCode,
          durationMs: capture.durationMs,
        });
      }
      if (!required(runtime.environment)) {
        const reason = runtime.reason
          ?? `Service '${ctx.config.service}' 当前未提供完整的 ${prefix}_* 配置，DB Store 未启用`;
        ctx.bundle.fill("runtime-config", { status: "unavailable", reason });
        return { configuration: { status: "unavailable", reason } };
      }
      ctx.target = parseMysqlEnvTarget(environmentText(runtime.environment), {
        label: ctx.config.service,
        prefix,
      });
      const configuration = {
        backend: ctx.capability.backend,
        endpoint: `${ctx.target.host}:${ctx.target.port}`,
        database: ctx.target.database,
        username: ctx.target.user,
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

export function makeDbAccessInspect(): Inspect<DbInspectionFacts, DbCollectContext> {
  return {
    id: "db-access",
    dependsOn: ["db-configuration"],
    run: async (ctx, facts) => {
      if (facts.configuration?.status !== "collected" || !ctx.target) {
        const reason = facts.configuration?.status === "collected"
          ? "DB target 未解析"
          : facts.configuration?.reason ?? "DB 配置未确认";
        ctx.bundle.fill("access-preparation", { status: "unavailable", reason });
        return { access: { status: "unavailable", reason } };
      }
      try {
        ctx.forwarder = await ServicePortForwarder.create(ctx.executor, {
          namespace: ctx.config.collect.kubernetes.namespace,
          kubeconfig: ctx.config.collect.kubernetes.kubeconfig,
          context: ctx.config.collect.kubernetes.context,
        });
        ctx.database = new MysqlDatabase((endpoint) => ctx.forwarder!.forward(endpoint), {
          connectTimeoutMs: 10_000,
          queryTimeoutMs: 15_000,
        });
        const access = { backend: "mysql" as const, channel: "service-port-forward" as const };
        ctx.bundle.fill("access-preparation", {
          status: "ok",
          output: `${JSON.stringify(access, null, 2)}\n`,
          ext: "json",
        });
        return { access: { status: "collected", ...access } };
      } catch (error) {
        const reason = `准备 DB 访问通道失败：${error instanceof Error ? error.message : String(error)}`;
        ctx.bundle.fill("access-preparation", { status: "failed", reason });
        return { access: { status: "failed", reason } };
      }
    },
  };
}
