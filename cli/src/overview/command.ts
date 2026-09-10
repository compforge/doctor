import type { Command } from "commander";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { runCommand } from "../app/command";
import { domainInput } from "../command/options";
import { overviewCommand, type OverviewCliOpts } from "./index";

export function registerOverviewCommand(program: Command, plugin?: PluginDefinition): void {
  program.command("overview").description("展示各 Service 值得注意的 Facet / Entry，可选采集代表请求")
    .option("--since <duration>", "近 10m、1h、6h、1d、3d；交互选择，非交互默认 1h")
    .option("--services <names>", "逗号分隔的 Service；默认全部 overview provider")
    .option("--tenant-id <id>", "只查看该租户")
    .option("--facet <id>", "选择待采集的 Facet；本身不触发采集")
    .option("--sample-count <number>", "默认采样 Entry 数（默认 5；交互模式可调整选择）", Number)
    .option("--collect-concurrency <number>", "批次内逐 ID 工作并发（默认 2；Pod 日志共享独立限额）", Number)
    .option("--include <commands>", "采集命令，逗号分隔；同 doctor collect，默认全部")
    .option("--collect", "确认采集所选 Entry 的代表请求")
    .option("-n, --namespace <ns>", "目标 namespace")
    .option("--kubeconfig <path>", "kubeconfig 路径")
    .option("--context <name>", "kubeconfig context")
    .option("--profile <name>", "使用指定 profile")
    .option("--config <path>", "config 文件路径")
    .option("-f, --format <format>", "html 或 bundle；默认 HTML + Bundle")
    .option("-o, --output <path>", "报告 basename/路径")
    .action(async (opts: OverviewCliOpts) => {
      await runCommand(overviewCommand, opts, { ...domainInput(opts), format: opts.format }, { plugin });
    });
}
