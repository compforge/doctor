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
import { terminalStderr, terminalStdout } from "../../terminal/output";
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
): Promise<number> {
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
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
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
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!access) return 130;
  terminalStdout.write(
    `[model] namespace: ${access.config.kubernetes.namespace}（${access.config.kubernetes.namespaceSource}）\n`,
  );

  try {
    const tenant = await resolveModelTenant({
      tenantId: opts.tenantId,
      tenantName: opts.tenantName,
      profileName: access.config.profileName,
      directory: access.directory,
    });
    if (!tenant) {
      terminalStderr.warning("[model] 已取消\n");
      return 130;
    }
    terminalStdout.write(`[model] tenant: ${tenant.name}（${tenant.id}）\n`);

    const models = await access.catalog.listAvailable(tenant.id, type);
    const selected = await selectModel({ models, query: opts.model });
    if (!selected) {
      terminalStderr.warning("[model] 已取消\n");
      return 130;
    }
    const model = requireInferenceModel(selected);
    if (model.type === "audio") {
      throw new Error("doctor model 当前支持 llm、embedding、rerank，暂不支持 audio inference");
    }
    terminalStdout.write(
      `[model] model: ${model.name}（type=${model.type}, provider=${model.provider}, id=${model.id}, `
      + `multimodal=${isMultimodalModel(model) ? "yes" : "no"}）\n`,
    );
    terminalStdout.write(`[model] inference endpoint: ${model.inference.baseUrl}\n`);

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
      terminalStdout.success("[model] 模型诊断完成，所需证据已完整取得。\n");
    }
    return result.exitCode;
  } catch (error) {
    terminalStderr.error(`[model] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await access.dispose();
  }
}
