import { Option, type Command } from "commander";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { runStandaloneCommand } from "../app/command";
import { serviceOption } from "../app/service-option";
import { loadActivePlugin } from "../plugin/loader";
import { writeOutput } from "../terminal/output";
import { KNOWLEDGE_KINDS, knowledgeIndex, selectKnowledgeOwners, type KnowledgeKind } from "./catalog";
import { lookupKnowledge, overviewKnowledge, overviewToMarkdown, readKnowledge } from "./read";

interface Options { services?: string[]; format?: "text" | "json"; all?: boolean; kind?: KnowledgeKind }

/** Parent and child flags contribute to the same selection, regardless of their position. */
function optionsFor(command: Command): Options {
  const own = command.opts<Options>();
  const parent = command.parent?.name() === "knowledge" ? command.parent.opts<Options>() : {};
  const services = [...(parent.services ?? []), ...(own.services ?? [])];
  return { ...parent, ...own, format: own.format ?? parent.format ?? "text",
    services: own.services === undefined && parent.services === undefined ? undefined : [...new Set(services)] };
}

function addOptions(command: Command): Command {
  return command.addOption(serviceOption("选择 Service 知识，默认产品级 Knowledge"))
    .addOption(new Option("-f, --format <format>", "输出格式").choices(["text", "json"]));
}

function output(value: unknown, text: () => string, options: Options): void {
  writeOutput(options.format === "json" ? `${JSON.stringify(value, null, 2)}\n` : `${text()}\n`);
}

/** Knowledge only organizes versioned Plugin/Service declarations; no profiles, clients or extensions run. */
export function registerKnowledgeCommand(program: Command, injected?: PluginDefinition): void {
  const plugin = () => injected ? Promise.resolve(injected) : loadActivePlugin();
  const knowledge = addOptions(program.command("knowledge")
    .description("展示产品或 Service 的概念、流程与知识目录")
    .allowExcessArguments(false)
    .addHelpText("after", `
知识来自当前 Plugin 的 Knowledge 声明，不代表目标环境的现场事实。
默认产品级；-s/--service 可重复选择服务，不隐式合并产品知识。
引用：<kind>/<id>[#<child-id>]；完整引用为 plugin/<id>[/service/<name>]/<kind>/<id>[#<child-id>]。

示例：
  doctor knowledge
  doctor knowledge -s <service>
  doctor knowledge list --all --kind dictionary
  doctor knowledge show article/<id>#<section-id>
  doctor knowledge lookup <dictionary> <query>
`));
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
