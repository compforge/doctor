const CGROUP_MEMORY_SCRIPT = `
emit_file() { key="$1"; file="$2"; if [ -r "$file" ]; then printf '%s=' "$key"; cat "$file"; fi; }
if [ -r /sys/fs/cgroup/memory.current ]; then
  echo version=2
  emit_file current_bytes /sys/fs/cgroup/memory.current
  emit_file limit_bytes /sys/fs/cgroup/memory.max
  emit_file peak_bytes /sys/fs/cgroup/memory.peak
  if [ -r /sys/fs/cgroup/memory.events ]; then
    while read key value; do printf 'event_%s=%s\n' "$key" "$value"; done < /sys/fs/cgroup/memory.events
  fi
elif [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then
  echo version=1
  emit_file current_bytes /sys/fs/cgroup/memory/memory.usage_in_bytes
  emit_file limit_bytes /sys/fs/cgroup/memory/memory.limit_in_bytes
  emit_file peak_bytes /sys/fs/cgroup/memory/memory.max_usage_in_bytes
  emit_file event_fail_count /sys/fs/cgroup/memory/memory.failcnt
  if [ -r /sys/fs/cgroup/memory/memory.oom_control ]; then
    while read key value; do printf 'event_%s=%s\n' "$key" "$value"; done < /sys/fs/cgroup/memory/memory.oom_control
  fi
else
  echo 'memory cgroup files unavailable' >&2
  exit 1
fi
`;

export interface CgroupMemoryFacts {
  version: 1 | 2;
  currentBytes?: string;
  limitBytes?: string;
  peakBytes?: string;
  events: Record<string, string>;
}

export function cgroupMemoryCmd(): string[] {
  return ["sh", "-c", CGROUP_MEMORY_SCRIPT];
}

export function parseCgroupMemoryFacts(output: string): CgroupMemoryFacts | undefined {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const version = values.get("version");
  if (version !== "1" && version !== "2") return undefined;

  const events: Record<string, string> = {};
  for (const [key, value] of values) {
    if (key.startsWith("event_")) events[key.slice("event_".length)] = value;
  }
  return {
    version: version === "1" ? 1 : 2,
    currentBytes: values.get("current_bytes"),
    limitBytes: values.get("limit_bytes"),
    peakBytes: values.get("peak_bytes"),
    events,
  };
}

/** v1/v2 的 oom_kill 都是累计计数；仅在 dump 前后差值增加时才能归因本次 OOM。 */
export function cgroupOomKillCount(facts: CgroupMemoryFacts | undefined): number | undefined {
  const value = facts?.events.oom_kill;
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}
