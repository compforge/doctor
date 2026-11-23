import type { Case } from "@compforge/spec-case/model";
import type { CaseSupport } from "@compforge/doctor-plugin";
import { caseMatchesCommand, type DoctorCaseCommand, type DoctorCaseSelection, type DoctorCaseSet } from "../case/catalog";
import { caseCurlPreview } from "../case/http";
import type { HttpScenarioOverrides } from "../collect/shared/http/config";
import { caseRef, resolveCaseChoices, type CaseChoice } from "../case/choices";
import { promptMultiSelect } from "./multi-select";
import { writeOutput } from "./output";
import { isInteractive } from "./policy";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "./selection";

export async function selectDoctorCases(input: {
  catalog: readonly DoctorCaseSet[];
  command: DoctorCaseCommand;
  caseSetId?: string;
  caseIds?: string;
  supports?: CaseSupport;
}): Promise<DoctorCaseSelection | undefined> {
  const available = input.catalog.map((source) => ({
    source,
    cases: source.caseSet.cases.filter((item) => (input.supports ?? source.supports ?? ((item: Case) => caseMatchesCommand(item, input.command)))(item)),
  })).filter((entry) => entry.cases.length > 0);
  if (!available.length) throw new Error(`没有可用于 doctor ${input.command} 的 Case`);
  const requestedSet = input.caseSetId;
  const matchingSets = requestedSet ? available.filter((entry) => entry.source.caseSet.caseset === requestedSet) : [];
  if (matchingSets.length > 1) throw new Error(`CaseSet '${requestedSet}' 同时来自多个来源；请避免重名`);
  let chosen: (typeof available)[number] | undefined = matchingSets[0];
  if (requestedSet && !chosen) throw new Error(`没有可用于 doctor ${input.command} 的 CaseSet '${requestedSet}'`);
  if (!chosen && available.length === 1) chosen = available[0];
  if (!chosen && isInteractive()) {
    printNumberedChoices(available, `[${input.command}] 可选 CaseSet：`, (entry) =>
      `${entry.source.caseSet.caseset} (${entry.source.source}${entry.source.service ? `/${entry.source.service}` : ""})`);
    chosen = await promptListedChoice({
      question: "请选择 CaseSet（编号，q 取消）：",
      match: (answer) => matchListedChoice(available, answer,
        (entry) => entry.source.caseSet.caseset, (entry) => entry),
      invalidMessage: "请输入列表中的 CaseSet 编号或名称。",
    });
    if (!chosen) return undefined;
  }
  if (!chosen) throw new Error(`有 ${available.length} 个可用 CaseSet；请用 --caseset 指定`);
  const requestedIds = input.caseIds?.split(",").map((id) => id.trim()).filter(Boolean);
  if (input.caseIds !== undefined && !requestedIds?.length) throw new Error("--cases 未解析出任何 Case ID");
  const defaults = input.command === "eval"
    ? chosen.cases.map((item) => item.id) : [chosen.cases[0]!.id];
  let ids = requestedIds;
  if (!ids && isInteractive()) {
    ids = await promptMultiSelect({
      choices: chosen.cases.map((item) => ({ name: item.id, description: item.desc })),
      defaults: defaults,
      title: `[${input.command}] 选择一个或多个 Case`,
    });
    if (!ids) return undefined;
  }
  ids ??= defaults;
  if (!ids.length) throw new Error("至少选择一个 Case");
  const choices = chosen.cases.map(item => ({source: chosen.source, item}));
  return {source: chosen.source, cases: resolveCaseChoices(choices, ids).map(choice => choice.item)};
}

export async function chooseServiceCases(catalog: readonly DoctorCaseSet[], options: {
  caseset?: string; cases?: string; supports: (source: DoctorCaseSet, item: Case) => boolean; browse?: boolean;
}): Promise<CaseChoice[] | undefined> {
  const groups = catalog.filter(s => !options.caseset || s.caseSet.caseset === options.caseset);
  if (options.caseset && !groups.length) throw new Error(`Unknown CaseSet: ${options.caseset}`);
  const choices: CaseChoice[] = [];
  for (const source of groups) {
    const rows = source.caseSet.cases.filter(item => options.browse || options.supports(source, item));
    if (isInteractive() && rows.length) writeOutput(`${source.service} / ${source.caseSet.caseset} (${source.sourceId ?? source.source})\n`);
    for (const item of rows) {
      choices.push({source, item});
      if (isInteractive()) writeOutput(`  ${choices.length}) ${item.id}  ${item.desc ?? ""}\n`);
    }
  }
  if (options.cases !== undefined) {
    return resolveCaseChoices(choices, options.cases.split(",").map(id => id.trim()));
  }
  if (!choices.length) return [];
  if (!isInteractive()) return [choices[0]!];
  return promptListedChoice({question:"请选择 Case（编号可用逗号分隔，q 取消）：", invalidMessage:"请输入已列出的 Case 编号。",
    match: answer => {
      const selected = answer.split(",").map(v => /^\d+$/.test(v.trim()) ? choices[Number(v.trim()) - 1] : undefined);
      return selected.every((c): c is CaseChoice => c !== undefined) ? [...new Set(selected)] : undefined;
    }});
}

export function printCaseDetails(choices: readonly CaseChoice[], baseUrl?: string, overrides?: HttpScenarioOverrides): void {
  for (const choice of choices) {
    const action = caseMatchesCommand(choice.item, "http") ? "可发送" : "仅预览";
    writeOutput(`\n${choice.source.service} / ${caseRef(choice)}（${action}）\n`);
    if (choice.item.desc) writeOutput(`${choice.item.desc}\n`);
    for (const [name, param] of Object.entries(choice.item.params ?? {})) {
      const source = param.source ? ` source=${param.source}` : "";
      const fallback = param.default !== undefined ? ` default=${JSON.stringify(param.default)}` : "";
      writeOutput(`  ${name}: ${param.type}${source}${fallback}\n`);
    }
    try {
      const commands = caseCurlPreview(choice, baseUrl, overrides);
      writeOutput(commands.length ? commands.join("\n\n") + "\n" : "cURL：此 Case 未提供离线 HTTP 请求模板。\n");
    } catch (error) {
      writeOutput(`无法生成 cURL：${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
