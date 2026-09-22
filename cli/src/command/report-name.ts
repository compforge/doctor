/**
 * 交付报告的统一命名约定：``doctor-<command>[-<first-input-id(12)>]-<yyyymmdd-hhmmss>``。
 *
 * - command：spec name 去掉 ``doctor `` 前缀（空格转 ``-``），如 ``trace`` / ``inspect``
 * - ids：调用输入的业务 ID（biz-id / trace_id / tenant_id 等），只取第一个，去掉非
 *   字母数字字符后截前 12 位；多个输入时以第一个为准（与 trace 命令"多个先用第一个"一致）
 * - 时间戳保证同一命令+同一 ID 重复执行不撞名——delivery 对已存在的 --output 拒绝覆盖，
 *   裸 ``doctor-<command>.html`` 会让同目录第二次执行必然失败（trace 曾因此交付失败）
 *
 * 命名分三层（finalize.ts 与 defineCommand 的 wiring）：
 *   1. ``CommandResult.reportName``（run 内拿到更准的 ID 时设置，如离线 trace 的 trace_id）
 *   2. ``CommandSpec.reportName(input)``（从调用输入推导，本助手是默认实现）
 *   3. finalize 兜底：``defaultCommandReportName(spec.name, [], now)``
 */
export function defaultCommandReportName(command: string, ids: readonly string[], now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const base = command.replace(/^doctor\s+/, "").replaceAll(" ", "-");
  const id = ids[0]?.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return id ? `doctor-${base}-${id}-${ts}` : `doctor-${base}-${ts}`;
}
