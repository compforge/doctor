import type { Command } from "commander";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { runPluginCommand } from "../app/command";
import { PLUGIN_COMMAND_CAPABILITIES } from "../app/plugin-command-capabilities";
import { runOverview, validateOverviewOptions, type OverviewCliOpts } from "./index";

export function registerOverviewCommand(program: Command, plugin?: PluginDefinition): void {
  program.command("overview").description("展示各 Service 值得注意的 Facet / Entry，可选采集代表请求")
    .option("--since <duration>", "近 10m、1h、6h、1d、3d；交互选择，非交互默认 1h")
    .option("--services <names>", "逗号分隔的 Service；默认全部 overview provider")
    .option("--tenant-id <id>", "只查看该租户")
    .option("--facet <id>", "选择待采集的 Facet；本身不触发采集")
    .option("--collect", "确认每个 Entry 采样一个请求并执行 data、trace、log collect")
    .option("-n, --namespace <ns>", "目标 namespace")
    .option("--kubeconfig <path>", "kubeconfig 路径")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "使用指定 profile")
    .option("--config <path>", "config 文件路径")
    .option("-f, --format <format>", "html 或 bundle；默认 HTML + Bundle")
    .option("-o, --output <path>", "报告 basename/路径")
    .action(async (opts: OverviewCliOpts) => {
      await runPluginCommand({
        name: "doctor overview", environment: { kubernetes: true },
        validate: () => validateOverviewOptions(opts), plugin: PLUGIN_COMMAND_CAPABILITIES.overview,
      }, opts, plugin, (activePlugin, context) => runOverview(opts, activePlugin, context));
    });
}
