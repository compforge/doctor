import type { Command } from "commander";
import { serviceOption } from "../app/service-option";
import { commandOptionsWithSources } from "../app/option-sources";
import { runCommand, type CommandRuntime } from "../app/command";
import { deliveryFormatOption } from "../app/command-defaults";
import { domainInput } from "../command/options";
import { computeCommand, type ComputeCliOpts } from "./index";

export function registerComputeCommand(program: Command, runtime: CommandRuntime = {}): void {
  program.command("compute").description("查看 Kubernetes 集群容量与各 Service 的 Workload 资源占用（只读）")
    .addOption(serviceOption("只查看指定 Service 的 Workload；默认全部，集群视图始终保留"))
    .option("--timeout <seconds>", "集群及每个 Service 各自的采集预算（秒，默认 30）")
    .option("--max-pods <count>", "每个采集范围的 Pod 上限（默认 1000）")
    .option("--max-nodes <count>", "集群 Node 上限（默认 500）")
    .option("--profile <name>", "使用指定 profile")
    .addOption(deliveryFormatOption(["html", "bundle", "summary"]).default("summary"))
    .option("-o, --output <path>", "报告 basename/路径")
    .addHelpText("after", "\n集群权限不足显示无权限，并继续采集 Service；指标缺失显示未知。\nrequests 为声明的资源需求；实际 CPU/内存来自 Metrics API。Service 之间可能共享 Pod，不可直接相加。\n")
    .action(async (opts: ComputeCliOpts, command: Command) => {
      opts = commandOptionsWithSources(command);
      await runCommand(computeCommand, opts, domainInput(opts), runtime);
    });
}
