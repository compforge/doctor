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
else
  echo 'memory cgroup files unavailable' >&2
  exit 1
fi
`;

/** 随 heap capture 顺手读取的 cgroup 内存事实；失败不影响 PyHeap 主链。 */
export function cgroupMemoryCmd(): string[] {
  return ["sh", "-c", CGROUP_MEMORY_SCRIPT];
}

/** cgroup v2 的 oom_kill 是累计计数；仅在 dump 前后差值增加时才能归因本次 OOM。 */
export function parseCgroupOomKillCount(output: string): number | undefined {
  const value = output.match(/^event_oom_kill=(\d+)$/m)?.[1];
  if (value === undefined) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}
