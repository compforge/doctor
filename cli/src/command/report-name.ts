/** Default delivery name includes the first business ID and timestamp; explicit output paths stay authoritative. */
export function defaultCommandReportName(command: string, ids: readonly string[], now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const base = command.replace(/^doctor\s+/, "").replaceAll(" ", "-");
  const id = ids[0]?.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return id ? `doctor-${base}-${id}-${ts}` : `doctor-${base}-${ts}`;
}
