import type { Command } from "commander";
import { commandOptionsWithSources } from "../app/option-sources";
import { runCommand, type CommandRuntime } from "../app/command";
import { deliveryFormatOption } from "../app/command-defaults";
import { domainInput } from "../command/options";
import { sampleCommand, type SampleCliOpts } from "./index";

export function registerSampleCommand(program: Command, runtime: CommandRuntime = {}): void {
  program.command("sample").description("按条件选取代表 biz-id，可选采集诊断数据；完整统计与体检使用 health")
    .option("--since <duration>", "近 10m、1h、6h、1d、3d；交互选择，非交互默认 1h")
    .option("--service <name>", "从指定 Service 选取样本；未指定时使用产品级采样入口")
    .option("--services <names>", "比较逗号分隔的多个 Service；不能与 --service 同用")
    .option("--tenant-id <id>", "只查看该租户")
    .option("--facet <id>", "选择 Facet 并查询代表对象；本身不触发采集")
    .option("--sample-count <number>", "代表请求的总采样上限（默认 5）", Number)
    .option("--collect-concurrency <number>", "批次内逐 ID 工作并发（默认 2；Pod 日志共享独立限额）", Number)
    .option("--include <commands>", "采集命令，逗号分隔；同 doctor collect，默认全部")
    .option("--collect", "确认采集所选 Entry 的代表请求")
    .option("--profile <name>", "使用指定 profile")
    .addOption(deliveryFormatOption(["html", "bundle"]))
    .option("-o, --output <path>", "报告 basename/路径")
    .action(async (opts: SampleCliOpts, command: Command) => {
      opts = commandOptionsWithSources(command);
      await runCommand(sampleCommand, opts, domainInput(opts), runtime);
    });
}
