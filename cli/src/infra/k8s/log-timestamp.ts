/** RFC3339 comparison at container-log precision; Date.parse alone loses sub-millisecond boundaries. */
export function logTimestampNanos(value: string): bigint | undefined {
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return undefined;
  const seconds = Date.parse(`${parts[1]}${parts[3]}`);
  if (!Number.isFinite(seconds)) return undefined;
  return BigInt(seconds) * 1_000_000n + BigInt((parts[2] ?? "").padEnd(9, "0"));
}
