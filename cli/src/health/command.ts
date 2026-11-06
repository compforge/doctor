import { serviceOption } from "../app/service-option";
import type { Command } from "commander";
import { commandOptionsWithSources } from "../app/option-sources";
import { runCommand, type CommandRuntime } from "../app/command";
import { deliveryFormatOption } from "../app/command-defaults";
import { domainInput } from "../command/options";
import { healthCommand, type HealthCliOpts } from "./index";

export function registerHealthCommand(program: Command, runtime: CommandRuntime = {}): void {
  program.command("health").description("主动巡检服务自身健康、依赖连通性与业务功能（非只读请求需确认）")
    .addHelpText("after", `
分析思路：
  按 self → deps → biz 逐层巡检；交互模式每层结束后询问是否继续，进入 biz 才准备身份。
结果解读：
  分别查看检查结果、发现的问题与覆盖缺口；回顾运行历史使用 overview。
`)
    .option("--scope <scopes>", "体检层级：self、deps、biz，逗号组合或 all（默认）")
    .option("--biz-id <id>", "按业务 ID 解析本次适用的下游依赖")
    .addOption(serviceOption("体检指定 Service；未指定时交互选择并默认全选，非交互检查全部支持体检的 Service"))
    .option("--tenant-id <id>", "Case 请求使用的租户")
    .option("--user-id <id>", "Case 请求使用的真实用户；未指定时读取 Plugin 配置或交互选择")
    .option("--profile <name>", "使用指定 profile")
    .addOption(deliveryFormatOption(["html", "bundle"]))
    .option("-o, --output <path>", "报告 basename/路径")
    .action(async (opts: HealthCliOpts, command: Command) => {
      opts = commandOptionsWithSources(command);
      await runCommand(healthCommand, opts, domainInput(opts), runtime);
    });
}
