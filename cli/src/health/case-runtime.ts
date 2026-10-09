import type { KubectlOptions, Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { WorkloadInstance, Extension, ServiceDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import { discoverKubernetesWorkload } from "../infra/k8s/workload";
import { enforceKubernetesAccess } from "../terminal/kubernetes-access";
import { createPodHttpSender, supportsPodCurlDiagnostics } from "../infra/http/pod";
import { openPluginContext } from "../plugin/context";
import { invokeExtension } from "../plugin/extension";
import type { CaseCheckActions } from "./cases";
import { resolveApprovalGate } from "../terminal/approval";
import { caseError } from "./case-http";

export function caseCheckActions(context: CommandContext, executor: Executor,
  kubernetes: KubectlOptions & { namespace: string }, directory: string, checkpoint: CaseCheckActions["checkpoint"]): CaseCheckActions {
  const invoke = async <I, O>(service: ServiceDefinition, extension: Extension<I, O>, query: I): Promise<O> => {
    const db = context.profile.value.db;
    const managed = await openPluginContext(executor, kubernetes, {
      config: context.profile.pluginConfig, service, capability: extension, signal: context.signal, clients: context.clients,
      databaseIdentity: db?.user ? { user: db.user, password: db.password ?? "" } : undefined,
      command: `doctor health ${extension.kind}`, authorization: context.kubernetes(executor).access,
    });
    try { return (await invokeExtension(extension, managed, query)).data; }
    finally { await managed.dispose(); }
  };
  return {
    directory, checkpoint, signal: context.signal,
    approve: (target, item) => resolveApprovalGate({ yes: context.options.yes })({
      id: `health-case:${target.uid}:${item.case.id}`, risk: "disrupt",
      title: `执行 Case：${item.case.desc ?? item.case.id}`,
      target: `${target.namespace}/${target.pod}/${target.container ?? ""}`,
      impact: [`${item.case.input.method} ${caseError(item.targets[0]!.url)}`,
        "执行真实请求，可能创建会话、产生模型费用或触发所选服务的业务动作；每个消费方实例执行一次，无自动重试。"],
    }),
    targets: async (service, binding) => {
      const definition = service.workloads.find(workload => workload.name === binding.workload)!;
      const location = definition.location;
      const resource = location.kind === "service" ? "services"
        : location.kind === "resource" ? `${location.resource_kind.toLowerCase()}s` : undefined;
      await enforceKubernetesAccess(context.kubernetes(executor).access, {
        command: "doctor health Case checks", needs: [
          { rule: { verb: "list", resource: "pods" }, requirement: "required", purpose: "定位消费方 Pod" },
          ...(resource ? [{ rule: { verb: "get", resource, resourceName: location.kind === "labels" ? undefined : location.name },
            requirement: "required" as const, purpose: "解析消费方 Workload" }] : []),
        ],
      });
      const { environment } = await context.environment(executor);
      const discovered = await discoverKubernetesWorkload(definition, executor, kubernetes.namespace, environment.name, () => {});
      if (discovered.unavailableReason) throw new Error(discovered.unavailableReason);
      const targets: WorkloadInstance[] = discovered.instances.filter(instance => discovered.pods.some(pod => pod.name === instance.pod && pod.phase === "Running"))
        .map(instance => {
          const pod = discovered.pods.find(pod => pod.name === instance.pod)!;
          const container = instance.container ?? (pod.containers.length === 1 ? pod.containers[0]!.name : undefined);
          // Missing/ambiguous containers fail per instance in sender(), preserving other replicas.
          return { ...instance, container };
        });
      return { targets: targets.slice(0, 10), ...(targets.length > 10 ? { truncated: `仅检查 ${targets.length} 个运行实例中的前 10 个` } : {}) };
    },
    sender: async target => {
      if (!target.container) throw new Error("Declare the consumer Workload container explicitly");
      await enforceKubernetesAccess(context.kubernetes(executor).access, {
        command: "doctor health Case checks", needs: [{ rule: { verb: "create", resource: "pods/exec", resourceName: target.pod },
          requirement: "required", purpose: "从消费方容器直接执行 HTTP 检查" }],
      });
      const result = await executor.exec(target, ["curl", "--version"], { timeoutMs: 10_000, signal: context.signal });
      if (!result.ok) throw new Error(result.stderr.trim() || `curl unavailable (exit=${result.exitCode}, timedOut=${result.timedOut})`);
      return createPodHttpSender(executor, target, supportsPodCurlDiagnostics(result.stdout));
    },
    consume: invoke,
    produce: invoke,
  };
}
