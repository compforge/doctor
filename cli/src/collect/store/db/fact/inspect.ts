import { borrowDatabase } from "../../../../datasource/database";
import type { Inspect } from "../../../inspection";
import type { DbCommandContext } from "../context";
import type { DbInspectionFacts } from "./model";
import { collectedFact, failedFact, unavailableFact } from "../../../protocol";

export function makeDbConfigurationInspect(): Inspect<DbInspectionFacts, DbCommandContext> {
  return {
    id: "db-configuration",
    run: async (ctx) => {
      const client = await borrowDatabase(ctx.command, { ...ctx.config, capability: ctx.capability }, ctx.executor);
      ctx.target = client.target;
      const configuration = {
        backend: ctx.capability.backend,
        endpoint: `${ctx.target.host}:${ctx.target.port}`,
        database: ctx.target.database,
        username: ctx.target.user,
        credentials: "configured" as const,
        source: "plugin",
        provenance: ctx.target.source ? {
          namespace: ctx.target.source.namespace, pod: ctx.target.source.pod,
          container: ctx.target.source.container, path: ctx.target.source.path,
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
        const client = await borrowDatabase(ctx.command, { ...ctx.config, capability: ctx.capability }, ctx.executor);
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
