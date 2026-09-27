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
    .action(() => { knowledge.outputHelp(); });
  knowledge.command("errors [query]")
    .description("列出错误定义，或按完整错误码、名称及别名片段查询")
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
