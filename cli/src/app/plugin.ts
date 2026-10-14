import { serviceOption } from "./service-option";
import { Option, type Command } from "commander";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { writeOutput } from "../terminal/output";
import { installPlugin, listPlugins, uninstallPlugin } from "../plugin";
import { runStandaloneCommand } from "./command";
import { formatPluginDescription, formatServiceDescription, formatServiceSummary } from "./plugin-description";

/** @spec Plugin displays identity, Service declarations and static caller relationships; Knowledge has its own command. */
export function registerPluginInfo(command: Command, plugin?: PluginDefinition): void {
  command.description("查看 Plugin / Service 目录与诊断声明，或安装/卸载 Plugin")
    .allowExcessArguments(false)
    .addOption(serviceOption("按逻辑 Service 名称展示诊断声明与上游关系"))
    .addOption(new Option("-f, --format <format>", "输出格式：summary 展示目录，text/json 包含诊断声明")
      .choices(["text", "json", "summary"]).default("text"))
    .addHelpText("after", `
Plugin 目录：
  不指定 --service 时展示产品身份与服务索引；指定后展示服务的诊断声明。
  Upstream 表示声明的调用方 Service，不代表现场 trace 或健康状态。
  产品和服务知识请使用 doctor knowledge。

示例：
  doctor plugin
  doctor plugin -s <name>
  doctor knowledge -s <name>
`)
    .action(async (opts: { format: "text" | "json" | "summary"; services?: readonly string[] }) => {
      await runStandaloneCommand("doctor plugin", async () => {
        let plugins = await listPlugins(plugin);
        if (opts.services !== undefined) {
          for (const name of opts.services) {
            if (!plugins.some(item => item.services.some(service => service.name === name || service.aliases.includes(name)))) {
              throw new Error(`Unknown Service '${name}' in the active Plugin`);
            }
          }
          plugins = plugins.map(item => ({
            id: item.id, version: item.version, source: item.source,
            services: item.services.filter(service => opts.services!.some(name => service.name === name || service.aliases.includes(name))),
          })).filter(item => item.services.length > 0);
        }
        if (opts.format === "json") {
          const output = opts.services === undefined ? plugins.map(item => ({ ...item,
            services: item.services.map(({ name, aliases, description, upstream }) => ({ name, aliases, description, upstream })),
          })) : plugins.map(item => ({ ...item, services: item.services.map(({ knowledge: _knowledge, ...service }) => service) }));
          writeOutput(`${JSON.stringify({ plugins: output }, null, 2)}\n`);
          return;
        }
        if (plugins.length === 0) {
          writeOutput("No active Plugin. Use doctor plugin install <archive> to load one.\n");
          return;
        }
        for (const item of plugins) {
          writeOutput(`${item.id}@${item.version}${opts.format === "summary" ? "" : ` (${item.source})`}\n`);
          if (opts.services === undefined) writeOutput(formatPluginDescription(item));
          if (item.services.length === 0) writeOutput("  (no declared Services)\n");
          for (const service of item.services) {
            if (opts.services !== undefined) {
              writeOutput(opts.format === "summary" ? formatServiceSummary(service) : formatServiceDescription(service));
            } else {
              const identity = `  ${service.name}${service.aliases.length ? ` (aliases: ${service.aliases.join(", ")})` : ""}`;
              const description = service.description ? ` — ${service.description}` : "";
              writeOutput(`${identity}${description}\n`);
              if (service.upstream !== undefined) writeOutput(`    Upstream：${service.upstream.join(", ") || "无"}\n`);
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
