import type { ExecResult, Executor } from "./executor";
import type { ServiceWorkloadDefinition } from "@compforge/doctor-plugin";
import { parsePods, type KubernetesPod } from "./pod";
import { parseServices, type KubernetesService } from "./service";

export interface KubernetesConfigMap {
  name: string;
  data: Record<string, string>;
}

export interface KubernetesEnvValue {
  name: string;
  value?: string;
  valueFrom?: {
    configMapKeyRef?: { name?: string; key?: string; optional?: boolean };
    secretKeyRef?: { name?: string; key?: string; optional?: boolean };
    fieldRef?: { fieldPath?: string };
    resourceFieldRef?: { resource?: string };
  };
}

export interface KubernetesContainerConfig {
  name: string;
  ports: Array<{ name?: string; containerPort: number }>;
  envFrom: Array<{
    prefix?: string;
    configMapRef?: { name?: string; optional?: boolean };
  }>;
  env: KubernetesEnvValue[];
}

export interface KubernetesDeploymentConfig {
  name: string;
  labels: Record<string, string>;
  containers: KubernetesContainerConfig[];
}

export interface KubernetesWorkloadConfigSnapshot {
  services: KubernetesService[];
  deployments: KubernetesDeploymentConfig[];
  configMaps: KubernetesConfigMap[];
  pods: KubernetesPod[];
}

export interface KubernetesWorkloadConfigCapture {
  serviceCapture?: ExecResult;
  deploymentCapture?: ExecResult;
  configMapCapture?: ExecResult;
  podCapture: ExecResult;
  snapshot?: KubernetesWorkloadConfigSnapshot;
  parseError?: string;
  deploymentParseError?: string;
  configMapParseError?: string;
  podParseError?: string;
}

interface ResourceList {
  items?: Array<Record<string, unknown>>;
}

function items(raw: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(raw) as ResourceList;
  if (!Array.isArray(parsed.items)) throw new Error("Kubernetes list 响应缺少 items");
  return parsed.items;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([name, child]) =>
    typeof child === "string" ? [[name, child]] : []
  ));
}

export function parseDeployments(raw: string): KubernetesDeploymentConfig[] {
  return items(raw).flatMap((item) => {
    const metadata = record(item.metadata);
    const spec = record(item.spec);
    const template = record(spec.template);
    const templateMetadata = record(template.metadata);
    const podSpec = record(template.spec);
    const name = typeof metadata.name === "string" ? metadata.name : "";
    if (!name) return [];
    const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
    return [{
      name,
      labels: stringRecord(templateMetadata.labels),
      containers: containers.flatMap((rawContainer): KubernetesContainerConfig[] => {
        const container = record(rawContainer);
        const containerName = typeof container.name === "string" ? container.name : "";
        if (!containerName) return [];
        const ports = Array.isArray(container.ports) ? container.ports : [];
        const envFrom = Array.isArray(container.envFrom) ? container.envFrom : [];
        const env = Array.isArray(container.env) ? container.env : [];
        return [{
          name: containerName,
          ports: ports.flatMap((rawPort) => {
            const port = record(rawPort);
            const containerPort = Number(port.containerPort);
            return Number.isInteger(containerPort)
              ? [{
                  name: typeof port.name === "string" ? port.name : undefined,
                  containerPort,
                }]
              : [];
          }),
          envFrom: envFrom.map((rawSource) => {
            const source = record(rawSource);
            const configMapRef = record(source.configMapRef);
            return {
              prefix: typeof source.prefix === "string" ? source.prefix : undefined,
              configMapRef: Object.keys(configMapRef).length
                ? {
                    name: typeof configMapRef.name === "string" ? configMapRef.name : undefined,
                    optional: configMapRef.optional === true,
                  }
                : undefined,
            };
          }),
          env: env.flatMap((rawEnv): KubernetesEnvValue[] => {
            const item = record(rawEnv);
            const envName = typeof item.name === "string" ? item.name : "";
            if (!envName) return [];
            const valueFrom = record(item.valueFrom);
            const configMapKeyRef = record(valueFrom.configMapKeyRef);
            const secretKeyRef = record(valueFrom.secretKeyRef);
            const fieldRef = record(valueFrom.fieldRef);
            const resourceFieldRef = record(valueFrom.resourceFieldRef);
            return [{
              name: envName,
              value: typeof item.value === "string" ? item.value : undefined,
              valueFrom: Object.keys(valueFrom).length
                ? {
                    configMapKeyRef: Object.keys(configMapKeyRef).length ? {
                      name: typeof configMapKeyRef.name === "string" ? configMapKeyRef.name : undefined,
                      key: typeof configMapKeyRef.key === "string" ? configMapKeyRef.key : undefined,
                      optional: configMapKeyRef.optional === true,
                    } : undefined,
                    secretKeyRef: Object.keys(secretKeyRef).length ? {
                      name: typeof secretKeyRef.name === "string" ? secretKeyRef.name : undefined,
                      key: typeof secretKeyRef.key === "string" ? secretKeyRef.key : undefined,
                      optional: secretKeyRef.optional === true,
                    } : undefined,
                    fieldRef: Object.keys(fieldRef).length ? {
                      fieldPath: typeof fieldRef.fieldPath === "string" ? fieldRef.fieldPath : undefined,
                    } : undefined,
                    resourceFieldRef: Object.keys(resourceFieldRef).length ? {
                      resource: typeof resourceFieldRef.resource === "string" ? resourceFieldRef.resource : undefined,
                    } : undefined,
                  }
                : undefined,
            }];
          }),
        }];
      }),
    }];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function parseConfigMaps(raw: string): KubernetesConfigMap[] {
  return items(raw).flatMap((item) => {
    const metadata = record(item.metadata);
    const name = typeof metadata.name === "string" ? metadata.name : "";
    return name ? [{ name, data: stringRecord(item.data) }] : [];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function selectorMatches(labels: Readonly<Record<string, string>>, selector: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([name, value]) => labels[name] === value);
}

export interface ResolvedKubernetesWorkload {
  definition: ServiceWorkloadDefinition;
  service?: KubernetesService;
  deployments: KubernetesDeploymentConfig[];
  pods: KubernetesPod[];
  unavailableReason?: string;
}

/** Resolve one declared Workload without assuming any relationship between its Service and Kubernetes names. */
export function resolveKubernetesWorkload(
  snapshot: KubernetesWorkloadConfigSnapshot,
  definition: ServiceWorkloadDefinition,
): ResolvedKubernetesWorkload {
  const discovery = definition.discovery;
  if (discovery.kind === "kubernetes-service") {
    const service = snapshot.services.find((item) => item.name === discovery.service);
    if (!service) {
      return {
        definition,
        deployments: [],
        pods: [],
        unavailableReason: `Kubernetes Service '${discovery.service}' 不存在`,
      };
    }
    return {
      definition,
      service,
      deployments: snapshot.deployments.filter((item) => selectorMatches(item.labels, service.selector)),
      pods: snapshot.pods
        .filter((pod) => pod.namespace === service.namespace && selectorMatches(pod.labels, service.selector))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }
  const labels = discovery.labels;
  return {
    definition,
    deployments: snapshot.deployments.filter((item) => selectorMatches(item.labels, labels)),
    pods: snapshot.pods
      .filter((pod) => selectorMatches(pod.labels, labels))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function selectWorkloadPodContainer(
  workload: ResolvedKubernetesWorkload,
  pod: KubernetesPod,
): { container?: KubernetesPod["containers"][number]; reason?: string } {
  const declared = workload.definition.container;
  if (declared) {
    const container = pod.containers.find((item) => item.name === declared);
    return container ? { container } : { reason: `Pod 不包含声明的 Container '${declared}'` };
  }
  if (workload.service) return selectPodServiceContainer(workload.service, pod);
  if (pod.containers.length === 1) return { container: pod.containers[0] };
  return {
    reason: pod.containers.length
      ? `Workload 未声明业务 Container：${pod.containers.map((item) => item.name).join(", ")}`
      : "Pod 没有 Container",
  };
}

export function selectWorkloadDeploymentContainer(
  workload: ResolvedKubernetesWorkload,
  deployment: KubernetesDeploymentConfig,
): { container?: KubernetesContainerConfig; reason?: string } {
  const declared = workload.definition.container;
  if (declared) {
    const container = deployment.containers.find((item) => item.name === declared);
    return container ? { container } : { reason: `Deployment 不包含声明的 Container '${declared}'` };
  }
  if (workload.service) return selectServiceContainer(workload.service, deployment);
  if (deployment.containers.length === 1) return { container: deployment.containers[0] };
  return {
    reason: deployment.containers.length
      ? `Workload 未声明业务 Container：${deployment.containers.map((item) => item.name).join(", ")}`
      : "Deployment 没有 Container",
  };
}

export function selectPodServiceContainer(
  service: KubernetesService,
  pod: KubernetesPod,
): { container?: KubernetesPod["containers"][number]; reason?: string } {
  if (pod.containers.length === 1) return { container: pod.containers[0] };
  const exact = pod.containers.find((item) => item.name === service.name);
  if (exact) return { container: exact };
  const byPort = pod.containers.filter((container) => service.ports.some((servicePort) =>
    (container.ports ?? []).some((port) => typeof servicePort.targetPort === "string"
      ? port.name === servicePort.targetPort
      : port.containerPort === (servicePort.targetPort ?? servicePort.port))
  ));
  if (byPort.length === 1) return { container: byPort[0] };
  return {
    reason: pod.containers.length
      ? `Pod 有多个 Container，Service port 无法唯一定位业务容器：${pod.containers.map((item) => item.name).join(", ")}`
      : "Pod 没有 Container",
  };
}

export function selectServiceContainer(
  service: KubernetesService,
  deployment: KubernetesDeploymentConfig,
): { container?: KubernetesContainerConfig; reason?: string } {
  if (deployment.containers.length === 1) return { container: deployment.containers[0] };
  const exact = deployment.containers.find((item) => item.name === service.name);
  if (exact) return { container: exact };
  const byPort = deployment.containers.filter((container) => service.ports.some((servicePort) =>
    container.ports.some((port) => typeof servicePort.targetPort === "string"
      ? port.name === servicePort.targetPort
      : port.containerPort === (servicePort.targetPort ?? servicePort.port))
  ));
  if (byPort.length === 1) return { container: byPort[0] };
  return {
    reason: deployment.containers.length
      ? `Deployment 有多个 Container，Service port 无法唯一定位业务容器：${deployment.containers.map((item) => item.name).join(", ")}`
      : "Deployment 没有 Container",
  };
}

export function resolveContainerEnvironment(
  container: KubernetesContainerConfig,
  configMaps: readonly KubernetesConfigMap[],
): { values: Record<string, string>; missing: string[] } {
  const configMapByName = new Map(configMaps.map((item) => [item.name, item]));
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const source of container.envFrom) {
    const name = source.configMapRef?.name;
    if (!name) continue;
    const configMap = configMapByName.get(name);
    if (!configMap) {
      if (!source.configMapRef?.optional) missing.push(`ConfigMap '${name}' 不存在`);
      continue;
    }
    const prefix = source.prefix ?? "";
    for (const [key, value] of Object.entries(configMap.data)) values[`${prefix}${key}`] = value;
  }
  for (const env of container.env) {
    if (env.value !== undefined) {
      values[env.name] = env.value;
      continue;
    }
    const configMapRef = env.valueFrom?.configMapKeyRef;
    if (configMapRef?.name && configMapRef.key) {
      const value = configMapByName.get(configMapRef.name)?.data[configMapRef.key];
      if (value !== undefined) values[env.name] = value;
      else if (!configMapRef.optional) missing.push(`ConfigMap '${configMapRef.name}' 缺少 key '${configMapRef.key}'`);
      continue;
    }
    const secretRef = env.valueFrom?.secretKeyRef;
    if (secretRef) {
      values[env.name] = `[secretKeyRef:${secretRef.name ?? "?"}/${secretRef.key ?? "?"}]`;
      continue;
    }
    const fieldPath = env.valueFrom?.fieldRef?.fieldPath;
    if (fieldPath) {
      values[env.name] = `[fieldRef:${fieldPath}]`;
      continue;
    }
    const resource = env.valueFrom?.resourceFieldRef?.resource;
    if (resource) values[env.name] = `[resourceFieldRef:${resource}]`;
  }
  return { values, missing };
}

export async function captureKubernetesWorkloadConfig(
  executor: Executor,
  namespace: string,
  includeDeploymentConfig: boolean,
  includeServices: boolean,
): Promise<KubernetesWorkloadConfigCapture> {
  const [serviceCapture, podCapture, deploymentCapture, configMapCapture] = await Promise.all([
    includeServices
      ? executor.run(["get", "services", "-o", "json"], { timeoutMs: 30_000 })
      : Promise.resolve(undefined),
    executor.run(["get", "pods", "-o", "json"], { timeoutMs: 30_000 }),
    includeDeploymentConfig
      ? executor.run(["get", "deployments", "-o", "json"], { timeoutMs: 30_000 })
      : Promise.resolve(undefined),
    includeDeploymentConfig
      ? executor.run(["get", "configmaps", "-o", "json"], { timeoutMs: 30_000 })
      : Promise.resolve(undefined),
  ]);
  const result: KubernetesWorkloadConfigCapture = {
    serviceCapture,
    deploymentCapture,
    configMapCapture,
    podCapture,
  };
  if (serviceCapture && !serviceCapture.ok) return result;
  try {
    result.snapshot = {
      services: serviceCapture ? parseServices(serviceCapture.stdout, namespace) : [],
      deployments: [],
      configMaps: [],
      pods: [],
    };
  } catch (error) {
    result.parseError = error instanceof Error ? error.message : String(error);
  }
  // 三类证据彼此独立；任一可选读取失败都不应抹掉已经取得的其它事实。
  if (result.snapshot && podCapture.ok) {
    try {
      result.snapshot.pods = parsePods(podCapture.stdout, namespace);
    } catch (error) {
      result.podParseError = error instanceof Error ? error.message : String(error);
    }
  }
  if (result.snapshot && deploymentCapture?.ok) {
    try {
      result.snapshot.deployments = parseDeployments(deploymentCapture.stdout);
    } catch (error) {
      result.deploymentParseError = error instanceof Error ? error.message : String(error);
    }
  }
  if (result.snapshot && configMapCapture?.ok) {
    try {
      result.snapshot.configMaps = parseConfigMaps(configMapCapture.stdout);
    } catch (error) {
      result.configMapParseError = error instanceof Error ? error.message : String(error);
    }
  }
  return result;
}
