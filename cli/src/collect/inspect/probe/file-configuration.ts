import { fileConfigurationId } from "../model";
import { extname } from "node:path";
import { parseDocument } from "yaml";
import type { ServiceFileDataSource } from "@compforge/doctor-plugin";
import { openPluginContext } from "../../../plugin/context";
import { currentCommandSignal } from "../../../command/execution-scope";
import { PROBE_RUNNABLE, type Probe } from "../../protocol";
import type { FileConfigurationObservation, InspectCommandContext, InspectConfig, InspectFacts, InspectObservation, JsonValue } from "../model";

/** Flatten observed keys for literal search; file/env precedence belongs to the application. */
export function parseFileConfiguration(bytes: Uint8Array, path: string): Record<string, JsonValue> {
  let value: unknown;
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const extension = extname(path).toLowerCase();
    if (extension === ".json") value = JSON.parse(raw);
    else if (extension === ".yaml" || extension === ".yml") {
      const document = parseDocument(raw);
      if (document.errors.length) throw new Error("invalid YAML");
      value = document.toJS({ maxAliasCount: 100 });
    } else throw new Error("unsupported format");
  } catch {
    // Parser errors can quote credential-bearing lines; only format/path enter failure evidence.
    throw new Error(`配置文件不是有效的 UTF-8 YAML/JSON，或格式不支持：${path}`);
  }
  const values: Record<string, JsonValue> = Object.create(null);
  const put = (key: string, value: JsonValue): void => {
    key ||= "$";
    if (Object.hasOwn(values, key)) throw new Error(`配置键展开后冲突：${path}`);
    values[key] = value;
  };
  const ancestors = new Set<object>();
  let count = 0;
  const visit = (item: unknown, key: string, depth: number): void => {
    if (++count > 20_000 || depth > 64) throw new Error(`配置结构超过解析上限：${path}`);
    if (item !== null && typeof item === "object") {
      if (ancestors.has(item)) throw new Error(`配置文件包含循环引用：${path}`);
      ancestors.add(item);
      if (Array.isArray(item)) {
        if (!item.length) put(key, []);
        item.forEach((child, index) => visit(child, `${key}[${index}]`, depth + 1));
      } else {
        const entries = Object.entries(item);
        if (!entries.length) put(key, {});
        for (const [name, child] of entries) visit(child, key ? `${key}.${name}` : name, depth + 1);
      }
      ancestors.delete(item);
    } else if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) {
      put(key, item);
    } else throw new Error(`配置包含不支持的值：${path}`);
  };
  visit(value, "", 0);
  return values;
}

/** @spec Failed sources remain evidence gaps and never become an empty successful configuration. */
export function makeFileConfigurationProbe(service: string, source: ServiceFileDataSource): Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext> {
  const id = fileConfigurationId(service, source.clientKey);
  return {
    id, evaluate: () => PROBE_RUNNABLE,
    run: async ctx => {
      const observation: FileConfigurationObservation = {
        id, kind: "file-configuration", schemaVersion: 1,
        producer: { origin: "core", id: "file-configuration" },
        service, workload: source.workload, path: source.path, status: "unavailable", values: {},
      };
      const started = performance.now();
      try {
        const context = await openPluginContext(ctx.executor, ctx.config.kube, {
          clients: ctx.command.clients, config: ctx.command.profile.pluginConfig,
          service: ctx.command.plugin.services.find(service)!, command: "doctor inspect · config",
          capability: { access: source.access }, authorization: ctx.authorization,
        });
        try {
          const file = await context.clients.get(source);
          Object.assign(observation, file.target);
          const bytes = await file.read({ maxBytes: 1024 * 1024, timeoutMs: 15_000, signal: currentCommandSignal() });
          observation.values = parseFileConfiguration(bytes, source.path);
          observation.status = "collected";
        } finally { await context.dispose(); }
      } catch (error) {
        currentCommandSignal()?.throwIfAborted();
        observation.reason = `读取配置失败：${service}/${source.workload} ${source.path}（${error instanceof Error ? error.message : String(error)}）`;
      }
      ctx.log(`[collect] 配置文件 ${service}/${source.workload} ${source.path}：${observation.status}`);
      ctx.bundle.addStep({ id, title: `${service}/${source.workload} ${source.path}`, risk: "observe",
        status: observation.status === "collected" ? "ok" : "unavailable", reason: observation.reason,
        durationMs: performance.now() - started, output: JSON.stringify(observation, null, 2), ext: "json" });
      return [observation];
    },
  };
}
