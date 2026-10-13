import { serviceOption } from "../app/service-option";
import type { Command } from "commander";
import { commandOptionsWithSources } from "../app/option-sources";
import { runCommand, type CommandRuntime } from "../app/command";
import { deliveryFormatOption } from "../app/command-defaults";
import { domainInput } from "../command/options";
import { sampleCommand, type SampleCliOpts } from "./index";

export function registerSampleCommand(program: Command, runtime: CommandRuntime = {}): void {
  program.command("sample").description("按条件选取代表 biz-id，可选采集诊断数据；完整统计与体检使用 health")
    .addHelpText("after", `
分析思路：
  Facet 表示观察维度，Entry 表示其中可采样的条目；选择条目取得代表 biz-id，再决定是否 collect。
结果解读：
  代表样本受查询条件和预算限制；样本数不等于总体数量，完整统计与主动体检应使用 health。
`)
    .option("--since <duration>", "近 10m、1h、6h、1d、3d；交互选择，非交互默认 1h")
    .addOption(serviceOption("从指定 Service 选取样本；未指定时使用产品级采样入口"))
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
