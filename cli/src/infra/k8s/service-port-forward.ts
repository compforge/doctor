import type { Executor, KubectlOptions } from "./executor";
import type { KubernetesEndpoint } from "./endpoint";
import { findPod, type KubernetesPod } from "./pod";
import { PortForwardScope, type StartPortForward } from "./port-forward";
import {
  findPodsForService,
  findService,
  listServiceNetwork,
  type KubernetesService,
} from "./service";

export interface ForwardedEndpoint extends KubernetesEndpoint {
  /** TLS 校验仍使用集群内逻辑地址，而不是本地 127.0.0.1。 */
  servername?: string;
}

export interface ForwardedServiceTarget extends ForwardedEndpoint {
  pod?: string;
}

/**
 * 把集群内 Service/Pod endpoint 映射为本机 endpoint，并缓存同一诊断中的 forward。
 * 它只理解 K8s 网络身份，不理解 Redis/MCP 等调用方协议。
 */
export class ServicePortForwarder {
  readonly #cache = new Map<string, Promise<ForwardedEndpoint>>();
  readonly #scope: PortForwardScope;

  private constructor(
    private readonly opts: KubectlOptions & { namespace: string },
    private readonly services: readonly KubernetesService[],
    private readonly pods: readonly KubernetesPod[],
    starter?: StartPortForward,
  ) {
    this.#scope = new PortForwardScope(starter);
  }

  static async create(
    executor: Executor,
    opts: KubectlOptions & { namespace: string },
    starter?: StartPortForward,
  ): Promise<ServicePortForwarder> {
    const network = await listServiceNetwork(executor, opts.namespace);
    return new ServicePortForwarder(opts, network.services, network.pods, starter);
  }

  get activeForwards() {
    return this.#scope.active;
  }

  forward(endpoint: KubernetesEndpoint): Promise<ForwardedEndpoint> {
    const key = `${endpoint.host}:${endpoint.port}`;
    let pending = this.#cache.get(key);
    if (!pending) {
      pending = this.#forward(endpoint);
      this.#cache.set(key, pending);
    }
    return pending;
  }

  /** 按 Service selector 把一个逻辑 endpoint 展开为每个 Running Pod 的独立 endpoint。 */
  async forwardServiceTargets(endpoint: KubernetesEndpoint): Promise<ForwardedServiceTarget[]> {
    const service = findService(this.services, endpoint, this.opts.namespace);
    if (!service) return [await this.forward(endpoint)];

    const pods = findPodsForService(this.services, this.pods, service.name, service.namespace);
    if (!pods.length) return [await this.forward(endpoint)];
    const servicePort = service.ports.find((port) => port.port === endpoint.port);
    // kubectl 无法把 Pod 的命名端口解析成数字；保留 Service 转发让 Kubernetes 完成映射。
    if (typeof servicePort?.targetPort === "string") return [await this.forward(endpoint)];
    const remotePort = servicePort?.targetPort ?? endpoint.port;
    const results = await Promise.allSettled(pods.map(async (pod) => ({
      ...await this.forward({ host: pod.name, port: remotePort }),
      pod: pod.name,
    })));
    const targets = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (targets.length) return targets;
    throw results.find((result) => result.status === "rejected")?.reason;
  }

  async #forward(endpoint: KubernetesEndpoint): Promise<ForwardedEndpoint> {
    const service = findService(this.services, endpoint, this.opts.namespace);
    const pod = service ? undefined : findPod(this.pods, endpoint, this.opts.namespace);
    const target = service
      ? { kind: "service" as const, name: service.name, namespace: service.namespace }
      : pod
        ? { kind: "pod" as const, name: pod.name, namespace: pod.namespace }
        : undefined;
    if (!target) return endpoint;

    const result = await this.#scope.start({
      ...this.opts,
      namespace: target.namespace,
      target: { kind: target.kind, name: target.name },
      remotePort: endpoint.port,
    });
    if (!result.value) {
      throw new Error(
        `为 ${target.kind}/${target.name} 建立 port-forward 失败：${result.reason ?? "unknown error"}`,
      );
    }
    return { host: "127.0.0.1", port: result.value.localPort, servername: endpoint.host };
  }

  stop(): void {
    this.#scope.stop();
    this.#cache.clear();
  }
}
