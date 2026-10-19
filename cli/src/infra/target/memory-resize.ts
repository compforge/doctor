import { posix } from "node:path";
import type { Executor, ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";
import type { K8sMutation } from "../k8s/mutation";
import { failReason } from "../k8s/result";
import { parsePodJson, pickContainer } from "../k8s/target";

export interface MemoryResizeTarget {
  namespace: string;
  pod: string;
  podUid: string;
  container: string;
  containerId: string;
  restartCount: number;
  node: string;
  image: string;
  imagePullSecrets: Array<{ name: string }>;
  declaredMemory?: string;
  cgroupPath: string;
  podCgroupPath: string;
}

export interface MemoryCgroup {
  path: string;
  inode: string;
  limitBytes: string;
  usageBytes: string;
  memswLimitBytes?: string;
}

export interface MemoryHierarchy {
  /** Leaf first, followed by every ancestor including the controller root. */
  groups: MemoryCgroup[];
  nodeAvailableBytes: string;
}

export interface MemoryLimitChange {
  path: string;
  inode: string;
  beforeBytes: string;
  afterBytes: string;
}

const TARGET_CGROUP_SCRIPT = String.raw`
set -eu
test -r /sys/fs/cgroup/memory/memory.limit_in_bytes || {
  echo 'doctor resize currently requires cgroup v1 memory controller' >&2; exit 1;
}
awk -F: '$2 ~ /(^|,)memory(,|$)/ {print $3}' /proc/self/cgroup
`;

export async function inspectMemoryResizeTarget(exec: Executor, pod: string, container: string): Promise<MemoryResizeTarget> {
  const captured = await exec.run(["get", "pod", pod, "-o", "json"], { timeoutMs: 20_000 });
  if (!captured.ok) throw new Error(`读取 pod/${pod} 失败：${failReason(captured)}`);
  const parsed = parsePodJson(captured.stdout);
  const picked = pickContainer(parsed, container);
  if (!picked.ok) throw new Error(picked.reason);
  const raw = JSON.parse(captured.stdout);
  const status = raw.status?.containerStatuses?.find((item: { name: string }) => item.name === container);
  if (parsed.phase !== "Running" || !parsed.nodeName || !status?.state?.running || !status.ready) {
    throw new Error(`pod/${pod} container/${container} 必须处于 Running / Ready`);
  }
  if (parsed.containers.length !== 1) throw new Error("doctor resize 首版仅支持单业务容器 Pod");
  const containerId = String(status.containerID ?? "");
  const runtimeId = containerId.match(/^[a-z0-9-]+:\/\/([a-f0-9]{32,64})$/)?.[1];
  const podUid = String(raw.metadata?.uid ?? "");
  if (!runtimeId || !/^[a-f0-9-]{36}$/.test(podUid)) throw new Error("无法确认 Pod UID / Container ID");
  const cgroup = await exec.exec({ pod, container }, ["sh", "-c", TARGET_CGROUP_SCRIPT], { timeoutMs: 10_000 });
  if (!cgroup.ok) throw new Error(`读取目标 cgroup 失败：${failReason(cgroup)}`);
  const cgroupPath = cgroup.stdout.trim();
  const podCgroupPath = posix.dirname(cgroupPath);
  // Resolve the running container's path, including systemd scopes, rather than guessing from names.
  if (!/^\/[A-Za-z0-9_./:@-]+$/.test(cgroupPath)
    || posix.normalize(cgroupPath) !== cgroupPath
    || ![podUid, podUid.replaceAll("-", "_")].some(uid => posix.basename(podCgroupPath).includes(`pod${uid}`))
    || !posix.basename(cgroupPath).includes(runtimeId)) {
    throw new Error(`目标 cgroup 路径与 Pod / Container 身份不匹配：${cgroupPath}`);
  }
  return {
    namespace: parsed.namespace, pod, podUid, container, containerId,
    restartCount: status.restartCount, node: parsed.nodeName,
    image: picked.value.image,
    imagePullSecrets: (raw.spec.imagePullSecrets ?? []).map((item: { name: string }) => ({ name: item.name })),
    declaredMemory: picked.value.limits?.memory, cgroupPath, podCgroupPath,
  };
}

export function assertSameMemoryTarget(expected: MemoryResizeTarget, actual: MemoryResizeTarget): void {
  for (const key of ["namespace", "pod", "podUid", "container", "containerId", "restartCount", "node", "cgroupPath"] as const) {
    if (expected[key] !== actual[key]) throw new Error(`目标实例已变化（${key}）；停止调整内存限制`);
  }
}

export function memoryResizeHelperMutation(target: MemoryResizeTarget, name: string, keepalive: readonly string[]): K8sMutation {
  const body = JSON.stringify({
    apiVersion: "v1", kind: "Pod",
    metadata: { name, namespace: target.namespace, labels: { "app.kubernetes.io/name": "doctor-resize" } },
    spec: {
      nodeName: target.node, restartPolicy: "Never", activeDeadlineSeconds: 600,
      automountServiceAccountToken: false, imagePullSecrets: target.imagePullSecrets,
      containers: [{
        name: "helper", image: target.image, imagePullPolicy: "IfNotPresent", command: keepalive,
        securityContext: { runAsUser: 0, runAsNonRoot: false, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
        resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { cpu: "100m", memory: "128Mi" } },
        volumeMounts: [
          { name: "hierarchy", mountPath: "/host-memory", readOnly: true },
          { name: "target", mountPath: "/target-memory", readOnly: false },
        ],
      }],
      volumes: [
        { name: "hierarchy", hostPath: { path: "/sys/fs/cgroup/memory", type: "Directory" } },
        { name: "target", hostPath: { path: `/sys/fs/cgroup/memory${target.podCgroupPath}`, type: "Directory" } },
      ],
    },
  });
  return {
    id: `memory-resize-helper/${name}`, access: { verb: "create", resource: "pods" },
    dryRun: { args: ["create", "--dry-run=server", "-f", "-", "-o", "name"], stdin: body, timeoutMs: 20_000 },
    execute: { args: ["create", "-f", "-", "-o", "name"], stdin: body, timeoutMs: 20_000 },
  };
}

/** Arguments, rather than shell interpolation, carry every target-derived path and value. */
export function memoryHierarchyCmd(cgroupPath: string, mount = "/host-memory"): string[] {
  return ["sh", "-c", String.raw`
set -eu
mount=$1
path=$2
printf 'available_kib='; awk '/^MemAvailable:/ {print $2}' /proc/meminfo
while :; do
  dir="$mount$path"
  printf 'group=%s\n' "$path"
  printf 'inode='; ls -id "$dir" | awk '{print $1}'
  printf 'limit='; cat "$dir/memory.limit_in_bytes"
  printf 'usage='; cat "$dir/memory.usage_in_bytes"
  [ "$(cat "$dir/memory.use_hierarchy")" = 1 ] || { echo 'hierarchical memory accounting required' >&2; exit 1; }
  if [ -r "$dir/memory.memsw.limit_in_bytes" ]; then
    printf 'memsw='; cat "$dir/memory.memsw.limit_in_bytes"
  fi
  [ "$path" = / ] && break
  path=$(dirname "$path")
done
`, "doctor-memory-inspect", mount, cgroupPath];
}

export function parseMemoryHierarchy(output: string): MemoryHierarchy {
  const groups: MemoryCgroup[] = [];
  let nodeAvailableBytes: string | undefined;
  let group: Partial<MemoryCgroup> | undefined;
  for (const line of output.trim().split(/\r?\n/)) {
    const at = line.indexOf("=");
    const key = line.slice(0, at), value = line.slice(at + 1);
    if (key === "available_kib" && /^\d+$/.test(value)) nodeAvailableBytes = String(BigInt(value) * 1024n);
    if (key === "group") { group = { path: value }; groups.push(group as MemoryCgroup); }
    if (group && ["inode", "limit", "usage", "memsw"].includes(key)) {
      if (!/^\d+$/.test(value)) throw new Error(`无法解析 cgroup ${key}：${value}`);
      if (key === "inode") group.inode = value;
      if (key === "limit") group.limitBytes = value;
      if (key === "usage") group.usageBytes = value;
      if (key === "memsw") group.memswLimitBytes = value;
    }
  }
  if (!nodeAvailableBytes || !groups.length || groups.some(g => !g.path || !g.inode || !g.limitBytes || !g.usageBytes)) {
    throw new Error("cgroup 层级或节点可用内存证据不完整");
  }
  return { groups, nodeAvailableBytes };
}

export async function inspectMemoryHierarchy(exec: Executor, helper: string, target: MemoryResizeTarget): Promise<MemoryHierarchy> {
  const result = await exec.exec({ pod: helper, container: "helper" }, memoryHierarchyCmd(target.cgroupPath), { timeoutMs: 10_000 });
  if (!result.ok) throw new Error(`读取节点 cgroup 层级失败：${failReason(result)}`);
  return parseMemoryHierarchy(result.stdout);
}

/**
 * @spec Recheck every inode and expected limit before the first write; never shrink as cleanup.
 * @why A reused cgroup path or concurrent operator must not redirect an approved plan.
 */
export function applyMemoryLimitsCmd(target: MemoryResizeTarget, changes: readonly MemoryLimitChange[], mount = "/target-memory"): string[] {
  const args = changes.flatMap(change => {
    if (change.path !== target.podCgroupPath && change.path !== target.cgroupPath) throw new Error("调整范围超出目标 Pod / Container cgroup");
    if (BigInt(change.afterBytes) < BigInt(change.beforeBytes)) throw new Error("resize 不能降低内存上限");
    return [posix.relative(target.podCgroupPath, change.path) || ".", change.inode, change.beforeBytes, change.afterBytes];
  });
  return ["sh", "-c", String.raw`
set -eu
mount=$1
shift
check() {
  while [ "$#" -gt 0 ]; do
    dir="$mount/$1"
    [ "$(ls -id "$dir" | awk '{print $1}')" = "$2" ] || { echo 'cgroup inode changed' >&2; exit 1; }
    [ "$(cat "$dir/memory.limit_in_bytes")" = "$3" ] || { echo 'cgroup limit changed' >&2; exit 1; }
    shift 4
  done
}
check "$@"
while [ "$#" -gt 0 ]; do
  file="$mount/$1/memory.limit_in_bytes"
  printf '%s\n' "$4" > "$file"
  printf 'changed=%s:' "$1"; cat "$file"
  [ "$(cat "$file")" = "$4" ] || { echo 'limit readback mismatch' >&2; exit 1; }
  shift 4
done
`, "doctor-memory-apply", mount, ...args];
}

export async function applyMemoryLimits(exec: Executor, helper: string, target: MemoryResizeTarget, changes: readonly MemoryLimitChange[]): Promise<ExecResult> {
  return exec.exec({ pod: helper, container: "helper" }, applyMemoryLimitsCmd(target, changes), { timeoutMs: 20_000 });
}
