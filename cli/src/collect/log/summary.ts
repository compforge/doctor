import type { Summary } from "@compforge/doctor-plugin";
import type { LogOutput } from "./index";

/**
 * @spec Summaries describe capture and filter results, never infer application health or root cause.
 * @why Keep per-query counts: shared Pod captures can match multiple IDs and must not be added as unique logs.
 * @see {@link ../../../docs/command-output.md#摘要与原始证据}
 */
export function logSummary(output: LogOutput): Summary {
  return {
    title: "日志采集摘要（零命中不代表服务正常）",
    fields: [
      { label: "Namespace", path: ["namespace"] },
      { label: "Services", path: ["services"] },
      { label: "查询项数", path: ["items", "length"] },
      ...output.items.flatMap((item, index) => {
        const subject = item.bizId ?? "Service / 时间范围";
        const prefix = ["items", String(index)];
        return [
          { label: `${subject} · 状态`, path: [...prefix, "status"] },
          ...(item.stats ? [
            { label: `${subject} · 匹配事件（非错误数）`, path: [...prefix, "stats", "matchedEventCount"] },
            { label: `${subject} · 扫描 Pod`, path: [...prefix, "stats", "scannedPodCount"] },
          ] : []),
          ...(item.reason ? [{ label: `${subject} · 原因`, path: [...prefix, "reason"] }] : []),
          ...(item.missingEvidence?.length ? [{ label: `${subject} · 采集缺口`, path: [...prefix, "missingEvidence"] }] : []),
        ];
      }),
    ],
  };
}
