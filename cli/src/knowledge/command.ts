import { Option, type Command } from "commander";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { runStandaloneCommand } from "../app/command";
import { serviceOption } from "../app/service-option";
import { loadActivePlugin } from "../plugin/loader";
import { writeOutput } from "../terminal/output";
import { KNOWLEDGE_KINDS, knowledgeIndex, selectKnowledgeOwners, type KnowledgeKind } from "./catalog";
import { lookupKnowledge, overviewKnowledge, overviewToMarkdown, readKnowledge } from "./read";
import { searchKnowledge } from "./search";

interface Options { services?: string[]; format?: "text" | "json"; all?: boolean; kind?: KnowledgeKind }

/** Parent and child flags contribute to the same selection, regardless of their position. */
function optionsFor(command: Command): Options {
  const own = command.opts<Options>();
  const parent = command.parent?.name() === "knowledge" ? command.parent.opts<Options>() : {};
  const services = [...(parent.services ?? []), ...(own.services ?? [])];
  return { ...parent, ...own, format: own.format ?? parent.format ?? "text",
    services: own.services === undefined && parent.services === undefined ? undefined : [...new Set(services)] };
}

function addOptions(command: Command, description = "选择 Service 知识，默认产品级 Knowledge"): Command {
  return command.addOption(serviceOption(description))
    .addOption(new Option("-f, --format <format>", "输出格式").choices(["text", "json"]));
}

function output(value: unknown, text: () => string, options: Options): void {
  writeOutput(options.format === "json" ? `${JSON.stringify(value, null, 2)}\n` : `${text()}\n`);
}

/** Knowledge only organizes versioned Plugin/Service declarations; no profiles, clients or extensions run. */
export function registerKnowledgeCommand(program: Command, injected?: PluginDefinition): void {
  const plugin = () => injected ? Promise.resolve(injected) : loadActivePlugin();
  const knowledge = addOptions(program.command("knowledge")
    .description("查询产品或 Service 的静态知识：概念、流程、文章与词典")
    .allowExcessArguments(false)
    .addHelpText("after", ({ command }) => {
      const cli = command.parent?.name() ?? "doctor";
      return `
知识来自当前 Plugin 的 Knowledge 声明，不代表目标环境的现场事实。
概览默认产品级；search 默认搜索产品和全部 Service，指定 -s 时只搜索所选服务。
-s/--service 可重复选择服务，指定后不隐式合并产品知识。
引用：<kind>/<id>[#<child-id>]；完整引用为 plugin/<id>[/service/<name>]/<kind>/<id>[#<child-id>]。

示例：
  ${cli} knowledge
  ${cli} knowledge -s <service>
  ${cli} knowledge search "runtime error"
  ${cli} knowledge search "runtime" -s <service>
  ${cli} knowledge list --all --kind dictionary
  ${cli} knowledge show article/<id>#<section-id>
  ${cli} knowledge lookup <dictionary> <query>

AI 排查路径：先 search 定位知识，再 show 阅读必要正文；通过 plugin 确认服务与诊断能力，
然后执行 inspect/collect 或 trace/log/data 等命令获取现场证据，按知识中的流程验证判断。
`;
    }));
  knowledge.action(async (_options, command: Command) => runStandaloneCommand("doctor knowledge", async () => {
    const active = await plugin();
    const options = optionsFor(command);
    const owners = selectKnowledgeOwners(active, options);
    const services = options.services === undefined ? active?.services.services.map(service => ({
      name: service.name, aliases: service.aliases ?? [], description: service.description, upstream: service.upstream,
    })) ?? [] : undefined;
    output({ owners: owners.map(overviewKnowledge), services },
      () => [owners.length ? owners.map(overviewToMarkdown).join("\n\n") : "No active Plugin.",
        ...(services?.length ? ["Services:", services.map(service => `- ${service.name}${service.description ? ` — ${service.description}` : ""}`).join("\n")] : [])].join("\n\n"), options);
  }));
  addOptions(knowledge.command("list").description("列出可引用的知识对象"))
    .option("--all", "同时列出产品和全部 Service 知识")
    .addOption(new Option("--kind <kind>", "按知识种类过滤").choices([...KNOWLEDGE_KINDS]))
    .action(async (_options, command: Command) => runStandaloneCommand("doctor knowledge list", async () => {
      const options = optionsFor(command);
      const owners = selectKnowledgeOwners(await plugin(), options).map(owner => knowledgeIndex(owner, options.kind));
      output({ owners }, () => owners.flatMap(owner => [owner.namespace,
        ...owner.items.map(item => `- ${item.ref} · ${item.title} — ${item.summary}`),
        ...(owner.items.length ? [] : ["No knowledge declared."])]).join("\n") || "No active Plugin.", options);
    }));
  addOptions(knowledge.command("search <query>").description("搜索产品和全部 Service 知识；指定 -s 时仅搜索所选服务"),
    "限定搜索的 Service，默认产品和全部 Service")
    .allowExcessArguments(false)
    .addHelpText("after", "\n按空白分词，不区分大小写，所有词都需命中同一对象或子项。结果含短片段与完整引用，可继续 knowledge show <ref>。\n")
    .action(async (query: string, _options, command: Command) => runStandaloneCommand("doctor knowledge search", async () => {
      const options = optionsFor(command);
      const result = searchKnowledge(await plugin(), query, options);
      output(result, () => result.matches.length
        ? result.matches.map(match => `- ${match.ref} · ${match.title}\n  ${match.snippet}`).join("\n")
        : `No knowledge matches '${result.query}'.`, options);
    }));
  addOptions(knowledge.command("show <ref>").description("展示知识对象或 Step / Section / Entry"))
    .action(async (ref: string, _options, command: Command) => runStandaloneCommand("doctor knowledge show", async () => {
      const options = optionsFor(command);
      const { text, ...result } = readKnowledge(await plugin(), ref, options, options.format !== "json");
      output(result, () => `${result.ref}\n\n${text}`, options);
    }));
  addOptions(knowledge.command("lookup <dictionary> [query]").description("列出词典，或按词条 ID、名称与别名查找"))
    .action(async (dictionary: string, query: string | undefined, _options, command: Command) => runStandaloneCommand("doctor knowledge lookup", async () => {
      const options = optionsFor(command);
      const { text, ...result } = lookupKnowledge(await plugin(), dictionary, query, options, options.format !== "json");
      output(result, () => text, options);
    }));
}
