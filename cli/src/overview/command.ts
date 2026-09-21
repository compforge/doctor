import type { Command } from "commander";
import { commandOptionsWithSources } from "../app/option-sources";
import { runCommand, type CommandRuntime } from "../app/command";
import { deliveryFormatOption } from "../app/command-defaults";
import { domainInput } from "../command/options";
import { overviewCommand, type OverviewCliOpts } from "./index";

export function registerOverviewCommand(program: Command, runtime: CommandRuntime = {}): void {
  program.command("overview").description("展示各 Service 值得注意的 Facet / Entry，可选采集代表请求")
    .option("--since <duration>", "近 10m、1h、6h、1d、3d；交互选择，非交互默认 1h")
    .option("--services <names>", "逗号分隔的 Service；默认全部 overview provider")
    .option("--tenant-id <id>", "只查看该租户")
    .option("--facet <id>", "选择待采集的 Facet；本身不触发采集")
    .option("--sample-count <number>", "代表请求的总采样上限（默认 5）", Number)
    .option("--collect-concurrency <number>", "批次内逐 ID 工作并发（默认 2；Pod 日志共享独立限额）", Number)
    .option("--include <commands>", "采集命令，逗号分隔；同 doctor collect，默认全部")
    .option("--collect", "确认采集所选 Entry 的代表请求")
    .option("--profile <name>", "使用指定 profile")
    .addOption(deliveryFormatOption(["html", "bundle"]))
    .option("-o, --output <path>", "报告 basename/路径")
    .action(async (opts: OverviewCliOpts, command: Command) => {
      opts = commandOptionsWithSources(command);
      await runCommand(overviewCommand, opts, domainInput(opts), runtime);
    });
}
