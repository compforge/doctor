import { prepareCommandRequirements } from "../../command/prepare";
import { serializeEvidenceResult } from "../serialize";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand, CommandInputError, CommandStatus } from "../../command";
import { EvidenceBundle } from "../evidence";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { renderEvidence, writeEvidencePage } from "../../report/evidence";
import { escapeHtml } from "../output/html";
import { ParameterCancelled } from "../../terminal/parameters";

import { useLogger } from "../../terminal/log";
import { resolveDbRequest, validateDbInput, type DbInput } from "./input";
import { resolveDbProviders } from "./providers";
import { databaseFailure, discoverDatabases, selectDatabaseTarget } from "./discovery";
import { quoteIdentifier } from "./sql";
import { databaseDiscoverySummary } from "./summary";

type PreparedDb = { input: DbInput; request: Awaited<ReturnType<typeof resolveDbRequest>> };

export const dbCommand = defineCommand<DbInput, void, PreparedDb>({
  serialize: serializeEvidenceResult,
  name: "doctor db",
  validate: validateDbInput,
  render: (context, result) => renderEvidence(context, result, {
    command: "db", title: "数据库取证",
    render: artifact => writeEvidencePage(context, artifact, { title: "数据库取证", summaryHtml: `<pre>${escapeHtml(context.read(artifact, "summary.md"))}</pre>` }),
  }),
  prepare: async (context, input) => {
    await prepareCommandRequirements(context, { plugin: { command: "doctor db", needs: [{ requirement: "required", capability: { scope: "resource", name: "dataSources" }, purpose: "解析 Service 可访问的数据库目标" }] } });
    // Resolve syntax/input before environment access; a SQL file is not a script runner.
    let request;
    try { request = await resolveDbRequest(input); }
    catch (error) {
      if (error instanceof ParameterCancelled) return undefined;
      throw error;
    }
    await context.ensureEnvironment({ kubernetes: true });
    return { input, request };
  },
  run: async (context, { input, request }) => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-db-"));
    const bundle = new EvidenceBundle(directory);
    context.artifacts.add({ command: "db", path: directory });
    const startedAt = new Date().toISOString();
    let status = CommandStatus.Ok;
    let reason: string | undefined;
    let service = input.service;
    const targets: Record<string, unknown>[] = [];
    let selection: Record<string, unknown> | undefined;
    const results: Record<string, unknown>[] = [];
    let discoverySummary = "";
    try {
      const resolved = await resolveDbProviders(context, request);
      service = resolved.service;
      for (const provider of resolved.providers) {
        targets.push({
          id: provider.id, dataSources: provider.dataSources, backend: "mysql", host: provider.target.host, port: provider.target.port,
          database: provider.target.database, source: provider.source, provenance: provider.target.source ? {
            namespace: provider.target.source.namespace, pod: provider.target.source.pod,
            container: provider.target.source.container, path: provider.target.source.path,
          } : undefined
        });
      }
      for (const failure of resolved.failures) {
        targets.push({ id: failure.id, dataSources: [{ id: failure.id, description: failure.description }], error: failure.reason });
        bundle.addStep({ id: `target-${resolved.failures.indexOf(failure)}`, title: `解析 DB ${failure.id}`, risk: "observe", status: "failed", reason: failure.reason });
      }
      const discovery = await discoverDatabases(request, resolved.providers);
      if (request.action === "databases") discoverySummary = databaseDiscoverySummary(discovery, resolved.failures);
      for (const [index, item] of discovery.entries()) {
        const record = { target: item.provider.id, dataSources: item.provider.dataSources, ...item.result, error: item.error };
        results.push(record);
        // Structured JSON must remain valid; the query has already applied its row/byte bounds.
        const path = join(directory, `discovery-${index}.json`);
        writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
        bundle.addStep({
          id: `discovery-${index}`, title: `发现 DB ${item.provider.id}`, risk: "observe",
          status: item.error ? "failed" : item.result?.truncated ? "partial" : "ok",
          reason: item.error ?? item.result?.truncation, rawFilePath: path, ext: "json"
        });
      }
      const incomplete = resolved.failures.length > 0 || discovery.some(item => item.error || item.result?.truncated);
      if (request.action === "query" || request.action === "create-table") {
        if (resolved.failures.length) throw new CommandInputError("部分 Service 数据库目标无法解析，不能确认唯一查询目标；未执行 SQL");
        const selected = await selectDatabaseTarget(request, discovery);
        selection = { target: selected.provider.id, dataSources: selected.provider.dataSources, database: selected.database, table: selected.table };
        const sql = request.action === "query" ? request.sql!
          : `SHOW CREATE TABLE ${quoteIdentifier(selected.database)}.${quoteIdentifier(selected.table!)}`;
        const before = Date.now();
        const requestPath = join(directory, "query-request.json");
        writeFileSync(requestPath, JSON.stringify({ sql, values: request.values }, null, 2), { mode: 0o600 });
        bundle.addStep({ id: "query-input", title: "查询输入（可能含敏感业务值）", risk: "observe", status: "ok", rawFilePath: requestPath, ext: "json" });
        try {
          context.signal.throwIfAborted();
          const result = await selected.provider.query(sql, request.values, request.limits, selected.database);
          const record = { ...selection, ...result, durationMs: Date.now() - before };
          const path = join(directory, "query.json");
          writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
          bundle.addStep({
            id: "query", title: "执行有界只读 SQL", risk: "observe", status: result.truncated ? "partial" : "ok",
            reason: result.truncation, durationMs: Date.now() - before, rawFilePath: path, ext: "json"
          });
          results.push(record);
          if (result.truncated) status = CommandStatus.Partial;
        } catch (error) {
          const failure = databaseFailure(error);
          bundle.addStep({ id: "query", title: "执行有界只读 SQL", risk: "observe", status: "failed", reason: failure, durationMs: Date.now() - before });
          throw new Error(failure);
        }
      } else if (incomplete) {
        status = discovery.some(item => item.result) ? CommandStatus.Partial : CommandStatus.Failed;
        reason = "部分数据库未取得完整证据";
      }
      if (!resolved.providers.length) { status = CommandStatus.Failed; reason = "未解析到可访问的数据库目标"; }
    } catch (error) {
      status = error instanceof ParameterCancelled || context.signal.aborted ? CommandStatus.Cancelled : CommandStatus.Failed;
      reason = error instanceof Error ? error.message : "数据库取证失败";
      bundle.addStep({ id: "operation", title: "完成数据库操作", risk: "observe", status: "failed", reason });
    }
    const summary = `# 数据库取证\n\nService: ${service ?? "未选择"}\n操作: ${request.action}\n状态: ${status}\n${reason ?? ""}\n\n${discoverySummary}\n\n详细结果见 raw/ JSON 文件。\n`;
    bundle.writeSummary(summary);
    bundle.writeManifest({
      doctorVersion: DOCTOR_CLI_VERSION, target: { service, targets, selection }, inspectionFacts: { targets },
      params: { action: request.action, database: request.database, table: request.table, limits: request.limits },
      startedAt, finishedAt: new Date().toISOString()
    });
    writeFileSync(join(directory, "diagnosis.json"), JSON.stringify({ status, reason, service, targets, selection, results }, null, 2), { mode: 0o600 });
    if (discoverySummary) useLogger().info(`${discoverySummary}`);
    useLogger("db").info(`${status}；证据目录：${directory}`);
    return { status, reason, output: undefined, artifacts: context.artifacts.list() };
  },
});
