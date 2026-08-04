import { posix } from "node:path";
import type { ExecResult, ExecTarget, Executor } from "./executor";

export interface DeclaredContainerConfig {
  environment: Map<string, string>;
  files: Map<string, string>;
  captures: ExecResult[];
  reason?: string;
}

type ResourceKind = "configmap" | "secret";

function record(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function decodeData(kind: ResourceKind, raw: unknown): Record<string, string> {
  const data = record(record(raw).data);
  return Object.fromEntries(Object.entries(data).flatMap(([key, value]) => {
    if (typeof value !== "string") return [];
    return [[key, kind === "secret" ? Buffer.from(value, "base64").toString("utf8") : value]];
  }));
}

/**
 * 从 Pod 声明引用的 ConfigMap/Secret 还原所选 Container 的 env 与挂载文件。
 * 只读取被该 Container 引用的资源；敏感值仅存在内存，capture 只供调用方记录命令元数据。
 */
export async function loadDeclaredContainerConfig(
  executor: Executor,
  target: ExecTarget,
): Promise<DeclaredContainerConfig> {
  const captures: ExecResult[] = [];
  const podCapture = await executor.run(["get", "pod", target.pod, "-o", "json"], { timeoutMs: 20_000 });
  captures.push(podCapture);
  if (!podCapture.ok) {
    return {
      environment: new Map(),
      files: new Map(),
      captures,
      reason: `读取 Pod spec 失败：${podCapture.stderr.trim() || `exit=${podCapture.exitCode}`}`,
    };
  }

  let pod: Record<string, any>;
  try {
    pod = record(JSON.parse(podCapture.stdout));
  } catch (error) {
    return {
      environment: new Map(),
      files: new Map(),
      captures,
      reason: `Pod spec JSON 解析失败：${String(error)}`,
    };
  }
  const containers: Array<Record<string, any>> = Array.isArray(pod.spec?.containers)
    ? pod.spec.containers.map((item: unknown) => record(item))
    : [];
  const container = target.container
    ? containers.find((item) => item.name === target.container)
    : containers[0];
  if (!container) {
    return {
      environment: new Map(),
      files: new Map(),
      captures,
      reason: `Pod spec 中不存在 Container '${target.container ?? ""}'`,
    };
  }

  const cache = new Map<string, Record<string, string>>();
  const resource = async (kind: ResourceKind, name: string): Promise<Record<string, string>> => {
    const key = `${kind}/${name}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const capture = await executor.run(["get", kind, name, "-o", "json"], { timeoutMs: 20_000 });
    captures.push(capture);
    let decoded: Record<string, string> = {};
    if (capture.ok) {
      try {
        decoded = decodeData(kind, JSON.parse(capture.stdout));
      } catch {
        decoded = {};
      }
    }
    cache.set(key, decoded);
    return decoded;
  };

  const environment = new Map<string, string>();
  for (const source of Array.isArray(container.envFrom) ? container.envFrom.map(record) : []) {
    const configMapName = source.configMapRef?.name;
    const secretName = source.secretRef?.name;
    const kind: ResourceKind | undefined = configMapName ? "configmap" : secretName ? "secret" : undefined;
    const name = configMapName ?? secretName;
    if (!kind || !name) continue;
    const prefix = typeof source.prefix === "string" ? source.prefix : "";
    for (const [key, value] of Object.entries(await resource(kind, name))) {
      environment.set(`${prefix}${key}`, value);
    }
  }
  for (const rawEnv of Array.isArray(container.env) ? container.env.map(record) : []) {
    if (typeof rawEnv.name !== "string") continue;
    if (typeof rawEnv.value === "string") {
      environment.set(rawEnv.name, rawEnv.value);
      continue;
    }
    const configMap = rawEnv.valueFrom?.configMapKeyRef;
    const secret = rawEnv.valueFrom?.secretKeyRef;
    const kind: ResourceKind | undefined = configMap ? "configmap" : secret ? "secret" : undefined;
    const reference = configMap ?? secret;
    if (!kind || typeof reference?.name !== "string" || typeof reference?.key !== "string") continue;
    const value = (await resource(kind, reference.name))[reference.key];
    if (value !== undefined) environment.set(rawEnv.name, value);
  }

  const volumes = new Map<string, Record<string, any>>(
    (Array.isArray(pod.spec?.volumes)
      ? pod.spec.volumes.map((item: unknown) => record(item))
      : [])
      .filter((volume: Record<string, any>) => typeof volume.name === "string")
      .map((volume: Record<string, any>) => [volume.name as string, volume]),
  );
  const files = new Map<string, string>();
  for (const mount of Array.isArray(container.volumeMounts) ? container.volumeMounts.map(record) : []) {
    if (typeof mount.name !== "string" || typeof mount.mountPath !== "string") continue;
    const volume = volumes.get(mount.name);
    const configMap = volume?.configMap;
    const secret = volume?.secret;
    const kind: ResourceKind | undefined = configMap ? "configmap" : secret ? "secret" : undefined;
    const source = configMap ?? secret;
    const sourceName = kind === "secret" ? source?.secretName : source?.name;
    if (!kind || typeof sourceName !== "string") continue;
    const data = await resource(kind, sourceName);
    const items: Array<Record<string, any>> = Array.isArray(source.items)
      ? source.items.map((item: unknown) => record(item))
      : [];
    const paths = items.length
      ? items.flatMap((item) =>
          typeof item.key === "string" && typeof item.path === "string"
            ? [[item.path, item.key] as const]
            : []
        )
      : Object.keys(data).map((key) => [key, key] as const);
    for (const [relativePath, key] of paths) {
      const value = data[key];
      if (value === undefined) continue;
      const filePath = typeof mount.subPath === "string"
        ? mount.mountPath
        : posix.join(mount.mountPath, relativePath);
      files.set(filePath, value);
    }
  }
  return { environment, files, captures };
}
