import { Option, type Command } from "commander";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { writeOutput } from "../terminal/output";
import { installPlugin, listPlugins, uninstallPlugin } from "../plugin";
import { runStandaloneCommand } from "./command";
import { formatServiceDescription } from "./plugin-description";

export function registerPluginInfo(command: Command, plugin?: PluginDefinition): void {
  command.description("展示当前 Plugin 与 Service 声明，或安装/卸载 Plugin")
    .allowExcessArguments(false)
    .option("--service <name>", "按逻辑 Service 名称展示诊断能力详情（离线声明，不探测现场）")
    .addOption(new Option("-f, --format <format>", "输出格式")
      .choices(["text", "json"]).default("text"))
    .action(async (opts: { format: "text" | "json"; service?: string }) => {
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
          writeOutput(`${item.id}@${item.version} (${item.source})\n`);
          if (item.services.length === 0) writeOutput("  (no declared Services)\n");
          for (const service of item.services) {
            writeOutput(opts.service !== undefined
              ? formatServiceDescription(service)
              : `  ${service.name}${service.aliases.length ? ` (aliases: ${service.aliases.join(", ")})` : ""}${service.description ? ` — ${service.description}` : ""}  extensions: ${service.extensions?.map(item => `${item.id} (${item.kind})`).join(", ") || "-"}\n`);
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
