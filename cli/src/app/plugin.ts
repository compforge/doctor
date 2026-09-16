import { Option, type Command } from "commander";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { terminalStdout } from "../terminal/output";
import { installPlugin, listPlugins, uninstallPlugin } from "../plugin";
import { runStandaloneCommand } from "./command";

export function registerPluginInfo(command: Command, plugin?: PluginDefinition): void {
  command.description("展示当前 Plugin 与 Service 声明，或安装/卸载 Plugin")
    .allowExcessArguments(false)
    .addOption(new Option("-f, --format <format>", "输出格式")
      .choices(["text", "json"]).default("text"))
    .action(async (opts: { format: "text" | "json" }) => {
      await runStandaloneCommand("doctor plugin", async () => {
        const plugins = await listPlugins(plugin);
        if (opts.format === "json") {
          terminalStdout.write(`${JSON.stringify({ plugins }, null, 2)}\n`);
          return;
        }
        if (plugins.length === 0) {
          terminalStdout.write("No active Plugin. Use doctor plugin install <archive> to load one.\n");
          return;
        }
        for (const item of plugins) {
          terminalStdout.write(`${item.id}@${item.version} (${item.source})\n`);
          if (item.services.length === 0) terminalStdout.write("  (no declared Services)\n");
          for (const service of item.services) {
            terminalStdout.write(`  ${service.name}  capabilities: ${service.capabilities.join(", ") || "-"}; contributions: ${service.contributions.join(", ") || "-"}\n`);
          }
        }
      });
    });
}

export async function runPluginInstall(archive: string): Promise<void> {
  const result = await installPlugin(archive);
  terminalStdout.success(
    `plugin: ${result.ref} (${result.installed ? "installed and loaded" : "already installed; loaded"})\n`,
  );
}

export function runPluginUninstall(ref: string): void {
  uninstallPlugin(ref);
  terminalStdout.success(`plugin: ${ref} (unloaded and uninstalled)\n`);
}
