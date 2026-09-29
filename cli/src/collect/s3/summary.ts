import type { S3Request } from "./input";
import type { S3Result } from "./operations";

// Object names and text are untrusted terminal input; escape control bytes, retain readable Unicode.
function display(value: string): string { return JSON.stringify(value); }
export function s3Summary(request: S3Request, result: S3Result | undefined, identity: Record<string, unknown> | undefined, reason?: string): string {
  const location = request.bucket ? `s3://${request.bucket}/${request.key}` : "可见 buckets";
  const lines = [`S3 ${request.action} · ${display(location)}`,
    `Service: ${identity?.service ?? request.service ?? "未选择"} · DataSource: ${identity?.dataSource ?? "未选择"}`];
  if (identity) lines.push(`Endpoint: ${identity.endpoint} · 通道: ${identity.channel} · 执行位置: ${identity.executionLocation}`);
  if (!result) return [...lines, `失败：${reason ?? "未取得证据"}`].join("\n") + "\n";
  if (request.action === "ls") {
    lines.push("", "TYPE    SIZE (B)     MODIFIED                  NAME");
    for (const entry of result.entries) lines.push(
      `${entry.type === "object" ? "FILE  " : entry.type === "bucket" ? "BUCKET" : "DIR   "}  ${String(entry.size ?? "-").padEnd(11)}  ${(entry.modified?.toISOString() ?? "-").padEnd(24)}  ${display(entry.type === "bucket" ? entry.name + "/" : entry.name)}`,
    );
    lines.push("", `${result.entries.length} entries · ${result.complete ? "complete" : "partial"} · ${result.pages} pages`);
    if (result.complete && !result.entries.length) lines.push("当前查询范围内没有匹配项。");
    if (result.continuationToken) lines.push(`继续查询：--continuation-token ${display(result.continuationToken)}（保持相同目标与递归选项）`);
  } else if (result.complete || result.bytes) {
    if (result.metadata) lines.push("", JSON.stringify(result.metadata, null, 2));
    else lines.push("Bucket HEAD 成功。");
    if (result.bytes) {
      lines.push("", `读取 ${result.bytes.byteLength} bytes · ${result.complete ? "complete" : "partial"} · 原始内容: content.bin`);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
        if (text.includes("\0")) throw new Error("binary");
        lines.push("", text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
      } catch { lines.push("二进制或不完整 UTF-8 内容，请读取原始内容文件。"); }
    }
  }
  if (result.stoppedReason) lines.push(`停止原因：${result.stoppedReason}`);
  if (result.failure) lines.push(`失败：${result.failure.reason}`);
  return lines.join("\n") + "\n";
}
