import { Option, type Command } from "commander";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { runStandaloneCommand } from "../app/command";
import { loadActivePlugin } from "../plugin/loader";
import { writeOutput } from "../terminal/output";
import { formatErrorCatalogs, queryErrorCatalogs } from "./errors";

/** Knowledge reads versioned declarations without preparing profiles, clients or target access. */
export function registerKnowledgeCommand(program: Command, injected?: PluginDefinition): void {
  const knowledge = program.command("knowledge")
    .description("查询当前 Plugin 提供的离线诊断知识")
    .addHelpText("after", `
分析思路：
  读取当前 Plugin 随版本交付的知识定义，为已有现象提供术语、解释和调查方向。
结果解读：
  知识定义不是现场证据；用 errors 查询错误码后，结合对应请求的 trace / log / data 验证原因。
`)
    .action(() => { knowledge.outputHelp(); });
  knowledge.command("errors [query]")
    .description("列出错误定义，或按完整错误码、名称及别名片段查询")
    .addHelpText("after", `
结果解读：
  核对错误定义的来源与版本；匹配到定义只提供解释，未匹配也不代表现场没有该错误。
  根因仍需结合发生错误的请求、调用位置与运行态证据确认。
`)
    .option("--extension-namespace <namespace>", "精确选择 Extension namespace（不是 Kubernetes namespace）")
    .addOption(new Option("-f, --format <format>", "输出格式").choices(["text", "json"]).default("text"))
    .action(async (query: string | undefined, options: { extensionNamespace?: string; format: "text" | "json" }) => {
      await runStandaloneCommand("doctor knowledge errors", async () => {
        const plugin = injected ?? await loadActivePlugin();
        const result = queryErrorCatalogs(plugin, { query, namespace: options.extensionNamespace });
        writeOutput(options.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : formatErrorCatalogs(result));
      });
    });
}
