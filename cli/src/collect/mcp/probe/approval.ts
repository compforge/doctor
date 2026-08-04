import type { McpCollectContext } from "../model";

export async function approveProbeCall(
  ctx: McpCollectContext,
  id: string,
  title: string,
  target: string,
  impact: readonly string[],
): Promise<boolean> {
  const decision = await ctx.approve({ id, risk: "disrupt", title, target, impact });
  ctx.bundle.addStep({
    id: `approval-${id}`,
    title: `确认：${title}`,
    risk: "observe",
    status: decision.approved ? "ok" : "skipped",
    reason: decision.approved ? undefined : `未批准（source=${decision.source}）`,
    output: `approval_source=${decision.source}\ntarget=${target}\n${impact.map((item) => `impact=${item}`).join("\n")}`,
  });
  return decision.approved;
}
