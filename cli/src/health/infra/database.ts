import { serviceDataSources } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../../command";
import type { KubernetesCommandConfig } from "../../command/kubernetes-target";
import { borrowDatabase } from "../../datasource/database";
import { databaseFailure } from "../../collect/db/discovery";
import { useLogger } from "../../terminal/log";
import type { HealthProvider } from "../extensions";
import type { HealthInteraction } from "../interaction";

export interface HealthDatabaseCheck {
  service: string;
  dataSource: string;
  executionLocation: "doctor-host";
  status: "passed" | "failed" | "unavailable" | "cancelled" | "skipped" | "not-run";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  target?: { host: string; port: number; database: string };
  stage?: "prepare" | "query";
  response?: { rows: number; returnedOne: boolean; truncated: boolean };
  code?: string;
  reason?: string;
}

/**
 * @spec One canonical database source is approved and checked once per Health session, including refusal and failure.
 * @spec Approval precedes source initialization; the borrowed client's root lifecycle owns connection and cancellation.
 * @spec SELECT 1 uses a bounded read-only session and never queries business tables or retains credentials/driver messages.
 */
export class HealthDatabaseSession {
  private readonly checks = new Map<string, Promise<HealthDatabaseCheck>>();
  constructor(private readonly command: CommandContext, private readonly collect: KubernetesCommandConfig,
    private readonly executor: Executor, private readonly interaction: HealthInteraction) {}

  async check(provider: HealthProvider, checkpoint: (checks: HealthDatabaseCheck[]) => void): Promise<HealthDatabaseCheck[]> {
    const results: HealthDatabaseCheck[] = [];
    for (const reference of provider.databaseSources ?? []) {
      if (this.command.signal.aborted || this.interaction.stopped) break;
      const service = this.command.plugin.services.find(reference.service)!.name;
      const dataSource = reference.dataSource;
      if (results.some(check => check.service === service && check.dataSource === dataSource)) continue;
      const key = JSON.stringify([service, dataSource]);
      let pending = this.checks.get(key);
      if (!pending) {
        pending = Promise.resolve().then(() => this.probe(service, dataSource));
        this.checks.set(key, pending);
      }
      results.push(await pending);
      checkpoint(results);
    }
    return results;
  }

  private async probe(service: string, dataSource: string): Promise<HealthDatabaseCheck> {
    const started = Date.now();
    const result: HealthDatabaseCheck = { service, dataSource, executionLocation: "doctor-host",
      startedAt: new Date(started).toISOString(), status: "unavailable", stage: "prepare" };
    try {
      this.command.signal.throwIfAborted();
      const capability = serviceDataSources(this.command.plugin.services, service, "db").find(source => source.id === dataSource);
      if (!capability || capability.kind !== "db") throw new Error("DB DataSource 未注册");
      const decision = await this.interaction.approve({ id: "health-database", risk: "observe", title: "DB 连接与只读查询",
        target: `${service}/${dataSource}（MySQL）`,
        impact: ["从该 Service 数据源读取配置，由 Doctor Host 经配置的访问通道建立连接并认证。",
          "执行 SELECT 1 AS doctor_health，查询限时 10 秒，最多返回 1 行；不读取业务表。"],
      });
      if (!decision.approved) {
        result.status = this.interaction.stopped ? "not-run" : "skipped";
        result.reason = this.interaction.stopped ? "用户结束巡检" : "用户跳过 DB 检查";
        return result;
      }
      this.command.signal.throwIfAborted();
      const client = await borrowDatabase(this.command, { collect: this.collect, service, capability }, this.executor);
      const { host, port, database } = client.target;
      result.target = { host, port, database };
      result.stage = "query";
      this.command.signal.throwIfAborted();
      const response = await client.database.queryReadonly(client.target, "SELECT 1 AS doctor_health", [], {
        timeoutMs: 10_000, maxRows: 1, maxBytes: 1024,
      });
      this.command.signal.throwIfAborted();
      const returnedOne = response.rows.length === 1 && [1, "1"].includes(response.rows[0]!.doctor_health as number | string);
      result.response = { rows: response.rows.length, returnedOne, truncated: response.truncated };
      result.status = returnedOne && !response.truncated ? "passed" : "failed";
      if (result.status === "failed") result.reason = "SELECT 1 未返回预期的单行结果";
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)) result.code = code;
      result.status = this.command.signal.aborted ? "cancelled"
        : result.stage === "query" || result.code ? "failed" : "unavailable";
      result.reason = this.command.signal.aborted ? "DB 检查已取消"
        : result.stage === "prepare" && !result.code ? "无法准备 DB 连接配置或访问通道；未取得数据库检查证据" : databaseFailure(error);
    } finally {
      result.finishedAt = new Date().toISOString(); result.durationMs = Date.now() - started;
      useLogger("health").info(`infra DB ${service}/${dataSource}: ${result.status}${result.reason ? ` · ${result.reason}` : ""}`);
    }
    return result;
  }
}
