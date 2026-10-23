import { Option, type Command } from "commander";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandInputError, CommandStatus, defineCommand, type CommandInput } from "../command";
import { prepareCommandRequirements } from "../command/prepare";
import { commandOptions, domainInput } from "../command/options";
import { createKubernetesExecutor, resolveKubernetesCommandConfig, type KubernetesCommandConfig } from "../command/kubernetes-target";
import { runCommand, type CommandRuntime } from "../app/command";
import { commandOptionsWithSources } from "../app/option-sources";
import { deliveryFormatOption } from "../app/command-defaults";
import { serviceOption } from "../app/service-option";
import { useLogger } from "../terminal/log";
import type { ResourceQuery } from "@compforge/doctor-plugin";
import { resourceProviders, type ResourceSelection, type ResourceProvider } from "./catalog";
import { collectResources, resourceDeclaration, type ResourceResult } from "./collect";
import { resourceHtml, resourceSummary, resourceText } from "./report";
import { observeResource } from "./runtime";

export interface ResourceInput extends CommandInput, ResourceSelection {
  list?: boolean;
  namespace?: string;
  maxInstances?: number;
  timeout?: number;
  cursor?: string;
}
interface Prepared {
  providers: ResourceProvider[];
  input: ResourceInput;
  query: ResourceQuery;
  target?: { kube: KubernetesCommandConfig; executor: ReturnType<typeof createKubernetesExecutor> };
}
const formats = ["summary", "text", "json", "md", "html", "bundle", "manifest", "default"];

export const resourceCommand = defineCommand<ResourceInput, ResourceResult, Prepared>({
  name: "doctor resource",
  validate: input => {
    if (input.services !== undefined && (!input.services.length || input.services.some(name => !name.trim()))) throw new CommandInputError("--service 不能为空");
    for (const [name, value] of [["resource", input.resource], ["kind", input.kind], ["cursor", input.cursor]] as const) {
      if (value !== undefined && !value.trim()) throw new CommandInputError(`--${name} 不能为空`);
    }
    for (const [name, value, max] of [["max-instances", input.maxInstances ?? 100, 1000], ["timeout", input.timeout ?? 20, 300]] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new CommandInputError(`--${name} 必须是 1–${max} 的整数`);
    }
    if (input.list && input.cursor) throw new CommandInputError("--list 不接受 --cursor");
  },
  prepare: async (context, input) => {
    if (!formats.includes(context.options.format?.trim() || "summary")) throw new CommandInputError("不支持的 Resource 输出格式");
    if (context.options.format === "summary" && context.options.output) throw new CommandInputError("--format summary 不支持 --output，请选择 text/json/html");
    await prepareCommandRequirements(context, { plugin: { command: "doctor resource", needs: [] } });
    const providers = resourceProviders(context.plugin, input);
    if (input.cursor && providers.length !== 1) throw new CommandInputError("--cursor 需要通过 -s 和 --resource 唯一选择一个来源");
    const query: ResourceQuery = { maxInstances: input.maxInstances ?? 100, maxBytes: 1024 * 1024,
      timeoutMs: (input.timeout ?? 20) * 1000, cursor: input.cursor };
    let target: Prepared["target"];
    if (!input.list && providers.some(provider => provider.binding.observe.access.kubernetes?.length)) {
      await context.ensureEnvironment({ kubernetes: true });
      const kube = await resolveKubernetesCommandConfig({ ...commandOptions(context), namespace: input.namespace }, undefined, context);
      if (!kube) return undefined;
      target = { kube, executor: createKubernetesExecutor(kube) };
    }
    return { providers, input, query, target };
  },
  run: async (context, { providers, input, query, target }) => {
    const artifact = context.artifacts.add({ command: "resource", path: mkdtempSync(join(tmpdir(), "doctor-resource-")) });
    if (input.list) return { status: CommandStatus.Ok, artifacts: [artifact],
      output: { mode: "catalog", entries: providers.map(resourceDeclaration) } };
    const collected = await collectResources(providers, query, {
      signal: context.signal,
      observe: (provider, query) => observeResource(context, provider, query,
        provider.binding.observe.access.kubernetes?.length ? target : undefined),
      progress: (entry, phase) => {
        const log = useLogger("resource");
        const identity = `${entry.service}/${entry.resource.id}`;
        if (phase === "start") log.info(`正在读取 ${identity}（超时 ${query.timeoutMs / 1000}s）…`);
        else if (entry.issue?.kind === "permission_denied") log.info(`${identity}：无权限`);
        else if (entry.issue) log.warn(`${identity}：${entry.issue.message}`);
        else log.info(`${identity}：${entry.snapshot!.coverage.status}`);
      },
    });
    return { ...collected, artifacts: [artifact] };
  },
  serialize: async (context, result) => {
    if (!result.output) return { files: {} };
    const summary = resourceSummary(result.output);
    const files = { output: context.writeJson("output.json", result.output),
      summary: context.writeText("summary.md", summary), text: context.writeText("resource.txt", resourceText(result.output)) };
    const artifact = result.artifacts.find(item => item.command === "resource");
    if (artifact) context.bind(artifact, ".");
    return { files };
  },
  render: async (context, result) => {
    // Serialize owns the evidence. Render only reads the already materialized output.
    const artifact = result.artifacts.find(item => item.command === "resource");
    if (!artifact) return { title: "Resource", sections: [] };
    context.write(artifact, resourceHtml(context.json<ResourceResult>(artifact, "output.json")));
    return { title: "Resource", sections: [{ id: "resource", title: "Service 资源", status: result.status,
      pages: [context.page(artifact, { title: "资源快照", status: result.status })] }] };
  },
});

export function registerResourceCommand(program: Command, runtime: CommandRuntime = {}): void {
  program.command("resource").description("查看 Service 管理或使用的资源数量、规模与实例（只读）")
    .helpGroup("Collect · 采集与分析:")
    .addOption(serviceOption("限定 Service；默认展示所有声明 Resource 的 Service"))
    .option("--resource <id>", "按资源集合 ID 筛选")
    .option("--kind <kind>", "按 Plugin 声明的资源类别筛选，例如 bed、sandbox、volume")
    .option("-l, --list", "仅列出静态资源声明，不访问现场")
    .option("-n, --namespace <namespace>", "Kubernetes namespace")
    .addOption(new Option("--max-instances <count>", "每个来源最多返回的实例数，默认 100，上限 1000").argParser(Number))
    .addOption(new Option("--timeout <seconds>", "每个来源读取超时，默认 20 秒，上限 300 秒").argParser(Number))
    .option("--cursor <cursor>", "继续读取唯一选定来源的后续页")
    .option("--profile <name>", "使用指定 profile")
    .addOption(deliveryFormatOption(["summary", "text", "json", "md", "html", "bundle"]).default("summary"))
    .option("-o, --output <path>", "输出路径")
    .addHelpText("after", "\nResource 由 Service.resources 声明；kind 是 Plugin 定义的开放类别。\n默认展示全部匹配来源的一页快照，不隐式扫描全部实例。未知总量不填 0；多个 Service 的结果不相加。\n示例：doctor resource --kind volume -s worker\n      doctor resource --list\n")
    .action(async (_options, command: Command) => {
      const options = commandOptionsWithSources(command);
      await runCommand(resourceCommand, options, domainInput(options), runtime);
    });
}
