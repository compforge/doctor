import { escapeHtml } from "../../collect/output/report/components/content";
import { writeOutput } from "../../terminal/output";
import type { S3HealthCheck, S3HealthStep } from "./probe";

const labels = { upload: "上传", presign: "生成预签名 URL", download: "预签名下载并校验内容", cleanup: "清理" };
function detail(step: S3HealthStep): string {
  return [step.response?.httpStatus ? `HTTP ${step.response.httpStatus}` : undefined, step.failure?.message, step.reason, step.error, (step.response?.requestId ?? step.failure?.requestId) ? `RequestId=${step.response?.requestId ?? step.failure?.requestId}` : undefined].filter(Boolean).join(" · ");
}
export function printS3Health(check: S3HealthCheck): void {
  writeOutput(`  S3 读写检查 ${check.service}/${check.dataSource} · Doctor host → ${check.endpoint ?? "未解析"}: ${check.status}\n`);
  if (check.key) writeOutput(`    ${check.bucket}/${check.key}${check.versionId ? ` · versionId=${check.versionId}` : ""}\n`);
  if (check.connectivity) writeOutput(`    补充网络探测: ${check.connectivity.status} · ${check.connectivity.reason ?? ""}\n`);
  if (check.region) writeOutput(`    region=${check.region} · addressing=${check.addressStyle}\n`);
  if (check.reason) writeOutput(`    ${check.reason}\n`);
  for (const step of check.steps) writeOutput(`    ${labels[step.operation]}: ${step.status}${step.bytes !== undefined ? ` · ${step.bytes} bytes` : ""}${step.durationMs !== undefined ? ` · ${step.durationMs} ms` : ""}${detail(step) ? ` · ${detail(step)}` : ""}\n`);
}
export function s3HealthHtml(check: S3HealthCheck): string {
  return `<h3>S3 读写检查 · ${escapeHtml(check.dataSource)} · ${escapeHtml(check.status)}</h3>`
    + `<p>Doctor host → ${escapeHtml(check.endpoint ?? "未解析")}<br>${escapeHtml(`${check.bucket ?? ""}/${check.key ?? ""}`)}</p>`
    + `<p>Region: ${escapeHtml(check.region ?? "未解析")} · Addressing: ${escapeHtml(check.addressStyle ?? "未解析")}</p>`
    + (check.reason ? `<p>${escapeHtml(check.reason)}</p>` : "")
    + `<table><tr><th>步骤</th><th>结果</th><th>字节</th><th>耗时</th><th>原因</th></tr>`
    + check.steps.map(step => `<tr><td>${labels[step.operation]}</td><td>${escapeHtml(step.status)}</td><td>${step.bytes ?? "—"}</td><td>${step.durationMs ?? "—"} ms</td><td>${escapeHtml(detail(step))}${step.response ? `<details><summary>响应</summary><pre>${escapeHtml(JSON.stringify(step.response, null, 2))}</pre></details>` : ""}</td></tr>`).join("")
    + `</table>${check.connectivity ? `<details><summary>补充网络探测 · ${escapeHtml(check.connectivity.status)}</summary><pre>${escapeHtml(JSON.stringify(check.connectivity, null, 2))}</pre></details>` : ""}<details><summary>请求证据</summary><pre>${escapeHtml(JSON.stringify(check, null, 2))}</pre></details>`;
}
