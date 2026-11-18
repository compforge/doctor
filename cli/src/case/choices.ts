import type { Case } from "@compforge/spec-case/model";
import { isInteractive } from "../terminal/policy";
import { writeOutput } from "../terminal/output";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "../terminal/selection";
import type { DoctorCaseSet } from "./catalog";

export interface CaseChoice { source: DoctorCaseSet; item: Case }

export function caseRef({source, item}: CaseChoice): string {
  // A local file and a Plugin source named "local" may contribute the same CaseSet.
  const owner = source.source === "local" ? "@local" : encodeURIComponent(source.sourceId ?? "plugin");
  return [owner, encodeURIComponent(source.caseSet.caseset), item.id].join("/");
}

export async function chooseName(names: string[], label: string, option: string, preferred?: string) {
  if (!names.length) throw new Error(`没有可选的 ${label}`);
  if (names.length === 1) return names[0];
  if (!isInteractive()) {
    if (preferred) return preferred;
    throw new Error(`请用 ${option} 指定 ${label}：${names.join(", ")}`);
  }
  printNumberedChoices(names, `可选 ${label}：`, name => name);
  return promptListedChoice({question: `请选择 ${label}（编号${preferred ? `，默认 ${preferred}` : ""}，q 取消）：`,
    ...(preferred ? {emptyValue: preferred} : {}), match: answer => matchListedChoice(names, answer, x => x, x => x),
    invalidMessage: `请输入列表中的 ${label} 编号或名称。`});
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
      const available = options.supports(source, item);
      if (available) choices.push({source, item});
      if (isInteractive()) writeOutput(`  ${available ? choices.length + ")" : "（仅查看）"} ${item.id}  ${item.desc ?? ""}\n`);
    }
  }
  if (options.cases !== undefined) {
    const selected = options.cases.split(",").map(token => {
      const id = token.trim();
      const matches = choices.filter(c => c.item.id === id || caseRef(c) === id);
      if (matches.length !== 1) throw new Error(`Case '${id}' 不可选或重名，请使用 source/caseset/case`);
      return matches[0]!;
    });
    return [...new Set(selected)];
  }
  if (!choices.length) return [];
  if (!isInteractive()) return [choices[0]!];
  return promptListedChoice({question:"请选择 Case（编号可用逗号分隔，q 取消）：", invalidMessage:"请输入已列出的 Case 编号。",
    match: answer => {
      const selected = answer.split(",").map(v => /^\d+$/.test(v.trim()) ? choices[Number(v.trim()) - 1] : undefined);
      return selected.every((c): c is CaseChoice => c !== undefined) ? [...new Set(selected)] : undefined;
    }});
}
