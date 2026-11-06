import { serviceOption } from "../app/service-option";
import type { Command } from "commander";
import { commandOptionsWithSources } from "../app/option-sources";
import { runCommand, type CommandRuntime } from "../app/command";
import { deliveryFormatOption } from "../app/command-defaults";
import { domainInput } from "../command/options";
import { overviewCommand, type OverviewCliOpts } from "./index";

export function registerOverviewCommand(program: Command, runtime: CommandRuntime = {}): void {
  program.command("overview").description("回顾时间窗口内的错误与耗时分布，按需选取代表业务 ID 取证")
    .addHelpText("after", `
分析思路：
  先查看错误、诊断与耗时分布；支持采样的条目可取得代表 biz-id，再决定是否 collect。
结果解读：
  统计口径与覆盖范围由各提供方说明；样本数不等于总体数量，主动巡检使用 health。
`)
    .option("--since <duration>", "近 10m、1h、6h、1d、3d；交互选择，非交互默认 1h")
    .addOption(serviceOption("查看指定 Service 的运行统计；未指定时使用产品级概览"))
    .option("--tenant-id <id>", "只查看该租户")
    .option("--facet <id>", "选择 Facet 并查询代表对象；本身不触发采集")
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
