/**
 * Inspect 是 collect 开始阶段的只读算子：读取 environment + resolved target 的现实，
 * 产出规划动作所需的初始 Facts。必须先于 Probe——Facts 决定 Probe 跑不跑，
 * 反过来就成环了。Config / mode 是用户意图，Probe 结果是 Observation，都不进入 Facts。
 *
 * Facts 与 Observations 的边界是**访问规则，不是数据规则**：同一条事实可以两边
 * 都在（memory 的 canExec 既进 inspection_facts，又是 `kind: "target"` Observation
 * 的字段，因为 detector 要靠它判 coverage）——那是**投影**，不是污染。
 *
 * detector **读得到** Facts（经 Evidence<Observation, Facts>）——它经常要回答"这份证据
 * 为什么没拿到"，而原因只在 Facts 里（tracemallocStartup 来自 /proc/<pid>/environ，
 * 没有任何 observation 有）。但读的是领域 buildEvidence 显式挑选的子集，不是全局；
 * Finding 引用 fact 走 EvidenceRef.factPath，跟引用 observation 一样留痕。
 */
export interface Inspect<Facts extends object, Ctx = void> {
  id: string;
  dependsOn?: readonly string[];
  run(ctx: Ctx, facts: Readonly<Partial<Facts>>): Promise<Partial<Facts>>;
}

/** 用户允许本次确定性诊断执行到的最高副作用等级。 */
export type InspectionMode = "observe" | "overhead" | "disrupt";

export function parseInspectionMode(value: string | undefined): InspectionMode {
  const mode = value?.trim();
  if (!mode) throw new Error("--mode 必须指定 observe、overhead 或 disrupt");
  if (mode !== "observe" && mode !== "overhead" && mode !== "disrupt") {
    throw new Error(`--mode 只支持 observe、overhead 或 disrupt: '${mode}'`);
  }
  return mode;
}
