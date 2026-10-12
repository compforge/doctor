import type { Summary } from "@compforge/doctor-plugin";
import type { LogOutput } from "./index";

/**
 * @spec Correlation gaps limit identity coverage; capture gaps limit source/time coverage. Neither invalidates retained logs.
 * @why Keep the scope of uncertainty explicit instead of treating partial as an application failure.
 * @see {@link ../../../docs/commands/log.md#终端摘要}
 */
export function logEvidenceImpact(resolutionGaps: readonly string[], missingEvidence: readonly string[]): string[] {
  return [
    ...(resolutionGaps.length ? ["关联缺口影响：对象关联证据不完整，可能漏掉依赖这些身份匹配的日志；不能据此排除相关对象的问题。"] : []),
    ...(missingEvidence.some(gap => !resolutionGaps.includes(gap))
      ? ["采集缺口影响：部分来源或时段缺少日志，不能据此判断完整时间线或排除未采到的错误。"] : []),
  ];
}

/**
 * @spec Summaries describe capture and filter results, never infer application health or root cause.
 * @why Keep per-query counts: shared Pod captures can match multiple IDs and must not be added as unique logs.
 * @why Evidence and gaps precede context so bounded parent summaries retain both success and failure.
 * @see {@link ../../../docs/commands/log.md#终端摘要}
 * @see {@link ../../../docs/command-output.md#摘要与原始证据}
 */
export function logSummary(output: LogOutput): Summary {
  const impact = logEvidenceImpact(
    output.items.flatMap(item => item.resolutionGaps ?? []),
    output.items.flatMap(item => item.missingEvidence ?? []),
  );
  return {
    title: "日志采集摘要（零命中不代表服务正常）",
    ...(impact.length ? { text: [
      ...(output.items.some(item => (item.stats?.matchedEventCount ?? 0) > 0)
        ? ["已获得的日志仍可用于分析其中记录的行为。"] : []),
      ...impact,
    ].join(" ") } : {}),
    fields: [
      ...output.items.flatMap((item, index) => {
        const subject = item.bizId ?? "Service / 时间范围";
        const prefix = ["items", String(index)];
        return [
          { label: `${subject} · 状态`, path: [...prefix, "status"] },
          ...(item.stats ? [
            { label: `${subject} · 已获得匹配事件（非错误数）`, path: [...prefix, "stats", "matchedEventCount"] },
            { label: `${subject} · 扫描 Pod`, path: [...prefix, "stats", "scannedPodCount"] },
          ] : []),
          ...(item.reason ? [{ label: `${subject} · 原因`, path: [...prefix, "reason"] }] : []),
          ...(item.resolutionGaps?.length ? [{ label: `${subject} · 关联缺口`, path: [...prefix, "resolutionGaps"] }] : []),
          ...(item.missingEvidence ?? []).flatMap((gap, gapIndex) => item.resolutionGaps?.includes(gap) ? [] : [
            { label: `${subject} · 采集缺口`, path: [...prefix, "missingEvidence", String(gapIndex)] },
          ]),
        ];
      }),
      { label: "Namespace", path: ["namespace"] },
      { label: "Services", path: ["services"] },
      { label: "查询项数", path: ["items", "length"] },
    ],
  };
}
