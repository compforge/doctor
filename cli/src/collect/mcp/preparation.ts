import type { KubernetesCommandConfig } from "../../command/kubernetes-target";
import type { Executor } from "../../infra/k8s/executor";
import { ServicePortForwarder } from "../../infra/k8s/service-port-forward";

export interface PreparedServiceEndpoint {
  host: string;
  port: number;
  command?: string[];
}

export interface PreparedUrl {
  url: string;
  command?: string[];
}

/** Owns the temporary network access created during one MCP collection. */
export class McpCollectionPreparation {
  private constructor(private readonly forwarder: ServicePortForwarder) {}

  static async create(
    executor: Executor,
    collect: KubernetesCommandConfig,
  ): Promise<McpCollectionPreparation> {
    const forwarder = await ServicePortForwarder.create(executor, {
      namespace: collect.kubernetes.namespace,
      kubeconfig: collect.kubernetes.kubeconfig,
      context: collect.kubernetes.context,
    });
    return new McpCollectionPreparation(forwarder);
  }

  async forwardService(service: string, port: number): Promise<PreparedServiceEndpoint> {
    const activeBefore = this.forwarder.activeForwards.length;
    const endpoint = await this.forwarder.forward({ host: service, port });
    if (endpoint.host !== "127.0.0.1") {
      throw new Error(`namespace 中找不到 Service '${service}' 的端口 ${port}`);
    }
    const forward = this.forwarder.activeForwards.slice(activeBefore).at(-1)
      ?? this.forwarder.activeForwards.find((item) =>
        item.target.kind === "service" && item.target.name === service
      );
    return { host: endpoint.host, port: endpoint.port, command: forward?.command };
  }

  /** Preserve the configured path/query while making an in-cluster URL reachable locally. */
  async forwardUrl(value: string): Promise<PreparedUrl> {
    const original = new URL(value);
    const port = original.port
      ? Number(original.port)
      : original.protocol === "https:" ? 443 : 80;
    const activeBefore = this.forwarder.activeForwards.length;
    const endpoint = await this.forwarder.forward({ host: original.hostname, port });
    const forward = this.forwarder.activeForwards.slice(activeBefore).at(-1);
    const prepared = new URL(original);
    prepared.hostname = endpoint.host;
    prepared.port = String(endpoint.port);
    return { url: prepared.toString(), command: forward?.command };
  }

  close(): void {
    this.forwarder.stop();
  }
}
