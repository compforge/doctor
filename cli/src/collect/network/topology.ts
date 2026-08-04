import type { Executor } from "../../infra/k8s/executor";
import { infra } from "../../infra";
import {
  parsePods,
  type KubernetesPod,
} from "../../infra/k8s/pod";
import {
  findPodsForService,
  parseServices,
  type KubernetesService,
} from "../../infra/k8s/service";
import type { NetworkTopology } from "./model";

export const NETWORK_DEBUG_ENVIRONMENT_MISSING_REASON =
  "没有具备 NET_RAW 的 doctor debug environment；请先执行 doctor debug";

function failureReason(stderr: string, exitCode: number | null): string {
  return stderr.trim().split("\n")[0] || `exit=${exitCode ?? "unknown"}`;
}

function buildPortFilter(services: readonly KubernetesService[], containerPorts: readonly number[]): string {
  const ports = new Set<number>([80, 443, ...containerPorts]);
  for (const service of services) {
    for (const port of service.ports) {
      ports.add(port.port);
      if (typeof port.targetPort === "number") ports.add(port.targetPort);
    }
  }
  return `tcp and (${[...ports].sort((left, right) => left - right).map((port) => `port ${port}`).join(" or ")})`;
}

function podContainerPorts(raw: string): number[] {
  const pod = JSON.parse(raw) as any;
  return (pod.spec?.containers ?? []).flatMap((container: any) =>
    (container.ports ?? []).flatMap((port: any) =>
      Number.isInteger(port.containerPort) ? [port.containerPort as number] : []
    )
  );
}

function podContainers(raw: string): string[] {
  const pod = JSON.parse(raw) as any;
  return (pod.spec?.containers ?? []).flatMap((container: any) =>
    typeof container.name === "string" && container.name ? [container.name] : []
  );
}

function resolveDebugEnvironment(raw: string): { name: string; image: string } | undefined {
  const candidates = podContainers(raw).flatMap((container) =>
    infra.target.debugEngine.inspectEnvironments(raw, container)
  ).filter((fact) => fact.compatible && fact.capabilities.includes("NET_RAW"));
  const selected = candidates.at(-1);
  return selected
    ? { name: selected.executionContainer, image: selected.image }
    : undefined;
}

interface TopologyCapture {
  serviceResult: Awaited<ReturnType<Executor["run"]>>;
  podResult: Awaited<ReturnType<Executor["run"]>>;
}

export async function inspectNetworkTopology(
  executor: Executor,
  namespace: string,
  selectedNames: readonly string[],
  explicitFilter?: string,
): Promise<{ topology: NetworkTopology; captures: TopologyCapture }> {
  const [serviceResult, podResult] = await Promise.all([
    executor.run(["get", "services", "-o", "json"], { timeoutMs: 30_000 }),
    executor.run(["get", "pods", "-o", "json"], { timeoutMs: 30_000 }),
  ]);
  if (!serviceResult.ok) {
    throw new Error(`读取 Service 失败：${failureReason(serviceResult.stderr, serviceResult.exitCode)}`);
  }
  if (!podResult.ok) {
    throw new Error(`读取 Pod 失败：${failureReason(podResult.stderr, podResult.exitCode)}`);
  }
  const services = parseServices(serviceResult.stdout, namespace);
  const pods = parsePods(podResult.stdout, namespace);
  const requested: KubernetesService[] = [];
  const selectedPods = new Map<string, { pod: KubernetesPod; services: string[] }>();
  const missing: NetworkTopology["missing"] = [];
  const serviceFacts: NetworkTopology["services"] = [];
  const observedContainerPorts = new Set<number>();

  for (const name of selectedNames) {
    const service = services.find((item) => item.name === name && item.namespace === namespace);
    if (!service) {
      missing.push({ service: name, reason: `Service '${name}' 不存在`, required: true });
      serviceFacts.push({ name, ports: [], pods: [], optional: false });
      continue;
    }
    requested.push(service);
    const servicePods = findPodsForService(services, pods, name, namespace);
    if (!servicePods.length) {
      missing.push({ service: name, reason: `Service '${name}' 没有 Running Pod`, required: true });
    }
    serviceFacts.push({
      name,
      clusterIp: service.clusterIP,
      ports: service.ports.map((port) => port.port),
      pods: servicePods.map((pod) => pod.name),
      optional: false,
    });
    for (const pod of servicePods) {
      const previous = selectedPods.get(pod.name);
      if (previous) previous.services.push(name);
      else selectedPods.set(pod.name, { pod, services: [name] });
    }
  }

  const targets = await Promise.all([...selectedPods.values()].map(async ({ pod, services: owners }) => {
    const result = await executor.run(["get", "pod", pod.name, "-o", "json"], { timeoutMs: 20_000 });
    if (!result.ok) {
      missing.push({
        pod: pod.name,
        reason: `读取 Pod JSON 失败：${failureReason(result.stderr, result.exitCode)}`,
        required: true,
      });
      return undefined;
    }
    const debug = resolveDebugEnvironment(result.stdout);
    for (const port of podContainerPorts(result.stdout)) observedContainerPorts.add(port);
    if (!debug) {
      missing.push({
        pod: pod.name,
        reason: NETWORK_DEBUG_ENVIRONMENT_MISSING_REASON,
        required: true,
      });
      return undefined;
    }
    return {
      pod: pod.name,
      podIp: pod.ip,
      services: owners,
      debug: { pod: pod.name, container: debug.name },
      debugImage: debug.image,
    };
  }));

  return {
    captures: { serviceResult, podResult },
    topology: {
      services: serviceFacts,
      targets: targets.filter((target) => target !== undefined),
      missing,
      filter: explicitFilter?.trim() || buildPortFilter(requested, [...observedContainerPorts]),
    },
  };
}

export function parseNetworkServices(raw: string): string[] {
  const services: string[] = [];
  for (const item of raw.split(",")) {
    const name = item.trim();
    if (name && !services.includes(name)) services.push(name);
  }
  if (!services.length) throw new Error("--services 未解析出任何服务");
  return services;
}
