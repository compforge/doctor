import { commandOutcome, type CommandResult } from "../../command";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import {
  isMultimodalModel,
  openModelAccess,
  requireInferenceModel,
  resolveModelTenant,
  selectModel,
  type ModelAccess,
} from "../../model";

import { useLogger } from "../../terminal/log";
import {
  parseModelMaxOutputTokens,
  parseModelOutputFormat,
  parseModelPerformanceRepeat,
  parseModelTimeout,
  parseModelType,
} from "./config";
import type { CollectModelCliOptions } from "./model";
import { runModelDiagnosis } from "./runner";

export * from "./config";
export * from "./detector";
export * from "./fact/inspect";
export * from "./model";
export * from "./performance";
export * from "./probe";
export * from "./runner";

export async function runCollectModel(
  opts: CollectModelCliOptions,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<CommandResult<void>> {
  let type;
  let timeoutMs;
  let performanceRepeat;
  let maxOutputTokens;
  let format;
  try {
    type = parseModelType(opts.type);
    timeoutMs = parseModelTimeout(opts.timeout);
    performanceRepeat = parseModelPerformanceRepeat(opts.repeat);
    maxOutputTokens = parseModelMaxOutputTokens(opts.maxOutputTokens);
    format = parseModelOutputFormat(opts.format);
  } catch (error) {
    useLogger().error(`${error instanceof Error ? error.message : String(error)}`);
    return commandOutcome(2);
  }

  let access: ModelAccess | undefined;
  try {
    access = await openModelAccess({
      ...opts,
      command: "doctor model",
      plugin,
      commandContext,
    });
  } catch (error) {
    useLogger().error(`${error instanceof Error ? error.message : String(error)}`);
    return commandOutcome(2);
  }
  if (!access) return commandOutcome(130);
  useLogger("model").info(`namespace: ${access.config.kubernetes.namespace}（${access.config.kubernetes.namespaceSource}）`);

  try {
    const tenant = await resolveModelTenant({
      tenantId: opts.tenantId,
      tenantName: opts.tenantName,
      profileName: access.config.profileName,
      directory: access.directory,
      commandContext,
      promptTitle: "[model] 当前启用租户：",
    });
    if (!tenant) {
      useLogger("model").warn("已取消");
      return commandOutcome(130);
    }
    useLogger("model").info(`tenant: ${tenant.name}（${tenant.id}）`);

    const models = await access.catalog.query({
      identity: { kind: "tenant_id", value: tenant.id },
      constraints: { type },
    });
    const selected = await selectModel({
      models,
      query: opts.model,
      profileName: access.config.profileName,
      tenantId: tenant.id,
    });
    if (!selected) {
      useLogger("model").warn("已取消");
      return commandOutcome(130);
    }
    const model = requireInferenceModel(selected);
    if (model.type === "audio") {
      throw new Error("doctor model 当前支持 llm、embedding、rerank，暂不支持 audio inference");
    }
    useLogger("model").info(`model: ${model.name}（type=${model.type}, provider=${model.provider}, id=${model.id}, `
      + `multimodal=${isMultimodalModel(model) ? "yes" : "no"}）`);
    useLogger("model").info(`inference endpoint: ${model.inference.baseUrl}`);

    const inference = await access.createInference(model.inference, timeoutMs);
    if (opts.performance && model.type !== "llm") {
      throw new Error("--performance 当前只支持 llm 模型");
    }
    const result = await runModelDiagnosis({
      command: commandContext,
      tenant,
      model,
      catalog: access.catalog,
      inference,
      performance: opts.performance,
      repeat: performanceRepeat,
      timeoutMs,
      maxOutputTokens,
      format,
      output: opts.output,
      profileName: commandContext.profile.name,
    });
    if (result.exitCode === 0 && !result.diagnosis.findings.some(
      (finding) => finding.severity === "critical",
    )) {
      useLogger("model").success("模型诊断完成，所需证据已完整取得。");
    }
    return commandOutcome(result.exitCode);
  } catch (error) {
    useLogger("model").error(`${error instanceof Error ? error.message : String(error)}`);
    return commandOutcome(1);
  } finally {
    await access.dispose();
  }
}
