import { borrowDatabase, resolveDatabaseTarget } from "../../../../datasource/database";
import type { ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";
import type { Inspect } from "../../../inspection";
import type { DbCommandContext } from "../context";
import type { DbInspectionFacts } from "./model";
import { collectedFact, failedFact, unavailableFact } from "../../../protocol";

function captureReason(capture: ExecResult): string | undefined {
  return capture.ok ? undefined : capture.stderr.trim().split("\n")[0] || `exit=${capture.exitCode}`;
}

export function makeDbConfigurationInspect(): Inspect<DbInspectionFacts, DbCommandContext> {
  return {
    id: "db-configuration",
    run: async (ctx) => {
      const runtime = await resolveDatabaseTarget({ ...ctx.config, capability: ctx.capability }, ctx.executor, ctx.command);
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
      if (!runtime.target) {
        const reason = runtime.reason
          ?? `Service '${ctx.config.service}' DB Store 未启用`;
        ctx.bundle.fill("runtime-config", { status: "unavailable", reason });
        return { configuration: unavailableFact("store.db.configuration", "db-configuration", reason) };
      }
      ctx.target = runtime.target;
      const configuration = {
        backend: ctx.capability.backend,
        endpoint: `${ctx.target.host}:${ctx.target.port}`,
        database: ctx.target.database,
        username: ctx.target.user,
        credentials: "configured" as const,
        source: runtime.source,
        provenance: runtime.target.source ? {
          namespace: runtime.target.source.namespace, pod: runtime.target.source.pod,
          container: runtime.target.source.container, path: runtime.target.source.path,
        } : undefined,
      };
      ctx.bundle.fill("runtime-config", {
        status: "ok",
        output: `${JSON.stringify({ status: "collected", ...configuration }, null, 2)}\n`,
        ext: "json",
      });
      return { configuration: collectedFact("store.db.configuration", "db-configuration", configuration) };
    },
  };
}

export function makeDbAccessInspect(): Inspect<DbInspectionFacts, DbCommandContext> {
  return {
    id: "db-access",
    dependsOn: ["db-configuration"],
    run: async (ctx, facts) => {
      if (facts.configuration?.status !== "collected" || !ctx.target) {
        const reason = facts.configuration?.status === "collected"
          ? "DB target 未解析"
          : facts.configuration?.reason ?? "DB 配置未确认";
        ctx.bundle.fill("access-preparation", { status: "unavailable", reason });
        return { access: unavailableFact("store.db.access", "db-access", reason) };
      }
      try {
        const client = await borrowDatabase(ctx.command, { ...ctx.config, capability: ctx.capability }, ctx.executor, ctx.target);
        ctx.database = client.database;
        const access = { backend: "mysql" as const, channel: "service-port-forward" as const };
        ctx.bundle.fill("access-preparation", {
          status: "ok",
          output: `${JSON.stringify(access, null, 2)}\n`,
          ext: "json",
        });
        return { access: collectedFact("store.db.access", "db-access", access) };
      } catch (error) {
        const reason = `准备 DB 访问通道失败：${error instanceof Error ? error.message : String(error)}`;
        ctx.bundle.fill("access-preparation", { status: "failed", reason });
        return { access: failedFact("store.db.access", "db-access", reason) };
      }
    },
  };
}
