import type { OverviewFacet, OverviewQuery } from "@compforge/doctor-plugin";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "../terminal/selection";

export const OVERVIEW_WINDOWS = ["10m", "1h", "6h", "1d", "3d"] as const;
const DURATIONS: Record<string, number> = { "10m": 600_000, "1h": 3_600_000, "6h": 21_600_000, "1d": 86_400_000, "3d": 259_200_000 };

export function overviewWindow(since: string, now = new Date()): OverviewQuery["window"] {
  const duration = DURATIONS[since];
  if (!duration) throw new Error(`--since 支持 ${OVERVIEW_WINDOWS.join(", ")}`);
  return { from: new Date(now.getTime() - duration).toISOString(), to: now.toISOString() };
}

export async function selectOverviewWindow(interactive: boolean): Promise<string | undefined> {
  if (!interactive) return "1h";
  printNumberedChoices(OVERVIEW_WINDOWS, "概览时间范围", (value) => `近 ${value}`);
  return promptListedChoice({
    question: "选择时间范围 [默认 1h，q 退出]: ", emptyValue: "1h",
    match: (answer) => matchListedChoice(OVERVIEW_WINDOWS, answer, (value) => value, (value) => value),
    invalidMessage: "请输入编号或时间范围",
  });
}

export async function selectOverviewFacet(
  facets: readonly OverviewFacet[], opts: { collect?: boolean; facet?: string }, interactive: boolean,
  prompt: typeof promptListedChoice = promptListedChoice,
): Promise<string | undefined> {
  let facet = opts.facet ? facets.find((item) => item.id === opts.facet) : undefined;
  if (opts.facet && !facet) throw new Error(`Facet '${opts.facet}' 没有可采集的 Entry`);
  if (!interactive && !opts.collect) return undefined;
  if (!facet && facets.length === 1) facet = facets[0];
  if (!facet) {
    if (!interactive) throw new Error("多个 Facet 可采集；请使用 --collect --facet <id>");
    printNumberedChoices(facets, "可采集的 Facet", (item) => `${item.id} · ${item.title}`);
    const id = await prompt({
      question: "选择 Facet [回车或 q 仅查看概览]: ", emptyValue: "",
      match: (answer) => matchListedChoice(facets, answer, (item) => item.id, (item) => item.id),
      invalidMessage: "请输入编号或 Facet id",
    });
    facet = facets.find((item) => item.id === id);
  }
  if (!facet) return undefined;
  // --collect is explicit consent. Generic --yes must never turn overview into collection.
  if (opts.collect) return facet.id;
  const confirmed = await prompt({
    question: `采集 ${facet.title} 每个可采样 Entry 的一个请求（data、trace、log）？[y/N]: `,
    emptyValue: false,
    match: (answer) => /^(y|yes)$/i.test(answer) ? true : /^(n|no)$/i.test(answer) ? false : undefined,
    invalidMessage: "请输入 y 或 n",
  });
  return confirmed ? facet.id : undefined;
}
