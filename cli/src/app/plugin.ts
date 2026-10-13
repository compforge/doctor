import { Option, type Command } from "commander";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { writeOutput } from "../terminal/output";
import { installPlugin, listPlugins, uninstallPlugin } from "../plugin";
import { runStandaloneCommand } from "./command";
import { formatPluginDescription, formatServiceDescription, formatServiceSummary } from "./plugin-description";

export function registerPluginInfo(command: Command, plugin?: PluginDefinition): void {
  command.description("查看 Plugin / Service 的 concepts、workflows 与诊断声明，或安装/卸载 Plugin")
    .allowExcessArguments(false)
    .option("--service <name>", "按逻辑 Service 名称展示 concepts、workflows 与诊断能力（离线声明，不探测现场）")
    .addOption(new Option("-f, --format <format>", "输出格式：summary 展示业务知识，text/json 包含诊断声明")
      .choices(["text", "json", "summary"]).default("text"))
    .addHelpText("after", `
Plugin 知识：
  Plugin 通常对应一个产品，统一交付产品知识、Service 声明和排障 Skill。
  Plugin 与 Service 均可提供 concepts（核心对象与约束）和 workflows（从触发到完成的典型业务流程）。
  不指定 --service 时展示产品知识与服务索引；指定后增加该服务的知识与能力详情。
  这些内容随 Plugin 版本维护，离线读取，不探测目标环境。

示例：
  doctor plugin -f summary                  查看产品概念、典型流程与服务索引
  doctor plugin --service <name> -f summary  查看指定服务的概念与典型流程
  doctor plugin --service <name>            同时查看服务的诊断能力声明
`)
    .action(async (opts: { format: "text" | "json" | "summary"; service?: string }) => {
      await runStandaloneCommand("doctor plugin", async () => {
        let plugins = await listPlugins(plugin);
        if (opts.service !== undefined) {
          plugins = plugins.map(item => ({
            ...item, services: item.services.filter(service => service.name === opts.service || service.aliases.includes(opts.service!)),
          })).filter(item => item.services.length > 0);
          if (!plugins.length) throw new Error(`Unknown Service '${opts.service}' in the active Plugin`);
        }
        if (opts.format === "json") {
          writeOutput(`${JSON.stringify({ plugins }, null, 2)}\n`);
          return;
        }
        if (plugins.length === 0) {
          writeOutput("No active Plugin. Use doctor plugin install <archive> to load one.\n");
          return;
        }
        for (const item of plugins) {
          writeOutput(`${item.id}@${item.version}${opts.format === "summary" ? "" : ` (${item.source})`}\n`);
          writeOutput(formatPluginDescription(item));
          if (item.services.length === 0) writeOutput("  (no declared Services)\n");
          for (const service of item.services) {
            if (opts.service !== undefined) {
              writeOutput(opts.format === "summary" ? formatServiceSummary(service) : formatServiceDescription(service));
            } else {
              const identity = `  ${service.name}${service.aliases.length ? ` (aliases: ${service.aliases.join(", ")})` : ""}`;
              const description = service.description ? ` — ${service.description}` : "";
              const extensions = opts.format === "summary" ? ""
                : `  extensions: ${service.extensions?.map(item => `${item.id} (${item.kind})`).join(", ") || "-"}`;
              writeOutput(`${identity}${description}${extensions}\n`);
            }
          }
        }
      });
    });
}

export async function runPluginInstall(archive: string): Promise<void> {
  const result = await installPlugin(archive);
  writeOutput(`plugin: ${result.ref} (${result.installed ? "installed and loaded" : "already installed; loaded"})\n`);
}

export function runPluginUninstall(ref: string): void {
  uninstallPlugin(ref);
  writeOutput(`plugin: ${ref} (unloaded and uninstalled)\n`);
}
