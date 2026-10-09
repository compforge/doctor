import type { Command } from "commander";
import { commandOptionsWithSources } from "../app/option-sources";
import { runCommand, type CommandRuntime } from "../app/command";
import { deliveryFormatOption } from "../app/command-defaults";
import { domainInput } from "../command/options";
import { healthCommand, type HealthCliOpts } from "./index";

export function registerHealthCommand(program: Command, runtime: CommandRuntime = {}): void {
  program.command("health").description("展示系统统计并执行所选 Service 的体检（非只读请求需确认），不采样或采集业务诊断数据")
    .option("--since <duration>", "统计时间范围：10m、1h、6h、1d、3d；非交互默认 1h")
    .option("--service <name>", "体检指定 Service；未指定时查看产品统计")
    .option("--services <names>", "体检逗号分隔的多个 Service；不能与 --service 同用")
    .option("--tenant-id <id>", "只查看该租户")
    .option("--profile <name>", "使用指定 profile")
    .addOption(deliveryFormatOption(["html", "bundle"]))
    .option("-o, --output <path>", "报告 basename/路径")
    .action(async (opts: HealthCliOpts, command: Command) => {
      opts = commandOptionsWithSources(command);
      await runCommand(healthCommand, opts, domainInput(opts), runtime);
    });
}
