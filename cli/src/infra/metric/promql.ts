export function prometheusDuration(durationMs: number): string {
  if (durationMs % 60_000 === 0) return `${Math.max(1, durationMs / 60_000)}m`;
  if (durationMs % 1000 === 0) return `${Math.max(1, durationMs / 1000)}s`;
  return `${Math.max(1, Math.floor(durationMs))}ms`;
}

