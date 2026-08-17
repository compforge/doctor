import { escapeHtml } from "../output/html";
import { writeTabbedReport } from "../output/tabbed-report";
import type { DiagnosableStoreKind } from "./config";

export interface StoreReportTab {
  kind: DiagnosableStoreKind;
  html: string;
  /** 聚合层只表达产物是否交付；Evidence 完整度由各领域报告展示。 */
  status: "delivered" | "failed";
}

export function defaultStoreReportName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `doctor-store-${timestamp}`;
}

export function failedStoreTab(kind: DiagnosableStoreKind, bundlePath?: string): StoreReportTab {
  const detail = bundlePath
    ? `<p>失败 Evidence Bundle：<code>${escapeHtml(bundlePath)}</code></p>`
    : "<p>本轮未生成可交付的诊断报告，请查看终端错误。</p>";
  return {
    kind,
    status: "failed",
    html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:32px;color:#18212f}code{padding:2px 5px;background:#eef2f7}</style><body><h1>${escapeHtml(kind.toUpperCase())} Store 诊断失败</h1>${detail}</body></html>`,
  };
}

/** 把各 Store 的自包含 HTML 嵌入同一个页签壳；iframe 隔离各领域报告的样式与脚本。 */
export function writeTabbedStoreReport(outputPath: string, tabs: readonly StoreReportTab[]): void {
  writeTabbedReport(outputPath, {
    title: "doctor Store 诊断报告",
    description: "一次诊断，多 Store 结果",
    ariaLabel: "Store 诊断结果",
    tabs: tabs.map((tab) => ({
      key: tab.kind,
      label: tab.kind.toUpperCase(),
      html: tab.html,
      status: tab.status,
    })),
  });
}
