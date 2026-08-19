import type { TenantOutputFormat } from "./model";

export function parseTenantOutputFormat(value: string | undefined): TenantOutputFormat {
  const format = value?.trim() || "default";
  if (format !== "default" && format !== "bundle" && format !== "json" && format !== "html") {
    throw new Error(`--format 只支持 bundle、json 或 html: '${format}'`);
  }
  return format;
}

export function safeTenantId(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(normalized || "tenant").slice(0, 64).join("");
}

export function tenantReportName(tenantId: string, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `doctor-tenant-${safeTenantId(tenantId)}-${now.getFullYear()}${pad(now.getMonth() + 1)}`
    + `${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
