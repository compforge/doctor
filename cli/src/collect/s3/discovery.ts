import { serviceDataSources, servicesWithDataSource, type ServiceDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandInputError, type CommandContext } from "../../command";
import { createKubernetesExecutor, resolveKubernetesCommandConfig } from "../../command/kubernetes-target";
import { canPrompt, chooseParameter, inputParameter, ParameterCancelled } from "../../terminal/parameters";
import { useLogger } from "../../terminal/log";
import { resolveS3Provider } from "./provider";
import type { S3Input, S3Request } from "./input";

export async function deployedNamespaces(service: ServiceDefinition, executor: Executor, namespace: string | undefined,
  signal: AbortSignal, accessibleNamespaces: () => Promise<string[]>): Promise<string[]> {
  const found = new Set<string>();
  if (!service.workloads.length && namespace) found.add(namespace);
  for (const workload of service.workloads) {
    if (namespace && workload.namespace && workload.namespace !== namespace) continue;
    const location = workload.location;
    const resource = location.kind === "service" ? "services" : location.kind === "labels" ? "pods" : location.resource_kind;
    const scope = workload.namespace ?? namespace;
    const selector = location.kind === "labels" ? ["-l", Object.entries(location.labels).map(([name, value]) => name + "=" + value).join(",")]
      : ["--field-selector", "metadata.name=" + location.name];
    const list = (ns?: string) => executor.run(["get", resource, ...(ns ? ["-n", ns] : ["-A"]), ...selector,
      "--no-headers", "-o", "custom-columns=NS:.metadata.namespace"], { signal, timeoutMs: 15_000 });
    let results = [await list(scope)];
    if (!scope && !results[0]!.ok && /forbidden/i.test(results[0]!.stderr)) {
      results = [];
      for (const ns of await accessibleNamespaces()) {
        const result = await list(ns);
        if (!result.ok && /forbidden/i.test(result.stderr)) continue;
        results.push(result);
      }
    }
    for (const result of results) {
      if (!result.ok) throw new CommandInputError(`发现 ${service.name}/${workload.name} 失败：${result.stderr.trim()}；可用 -n 和 -s 指定目标`);
      for (const ns of result.stdout.trim().split(/\s+/)) if (ns) found.add(ns);
    }
  }
  return [...found].sort();
}

export async function selectInspectProvider(context: CommandContext, input: S3Input, request: S3Request) {
  await context.ensureEnvironment({ kubernetes: true });
  const collect = await resolveKubernetesCommandConfig({ ...input, ...context.options.environment, interactive: false }, undefined, context);
  if (!collect) throw new ParameterCancelled();
  const namespace = collect.kubernetes.namespaceSource === "default" ? undefined : collect.kubernetes.namespace;
  if (request.service && namespace) return resolveS3Provider(context, { ...input, namespace }, request);
  const executor = createKubernetesExecutor(collect);
  let scopeList: string[] | undefined;
  async function accessibleNamespaces() {
    if (scopeList) return scopeList;
    const listed = await executor.run(["get", "namespaces", "--no-headers", "-o", "custom-columns=NS:.metadata.name"],
      { signal: context.signal, timeoutMs: 15_000 });
    if (listed.ok) scopeList = listed.stdout.trim().split(/\s+/).filter(Boolean);
    else if (/forbidden/i.test(listed.stderr)) {
      scopeList = [await inputParameter("namespace（跨 namespace 发现权限不足，可用 -n 指定）", canPrompt(input))];
    } else throw new CommandInputError("列举 namespace 失败：" + listed.stderr.trim());
    return scopeList;
  }
  const candidates = servicesWithDataSource(context.plugin.services, "s3")
    .filter(s => !request.service || s.name === context.plugin.services.find(request.service)?.name);
  const targets: Array<{ namespace: string; service: string; id: string }> = [];
  for (const service of candidates) {
    const sources = serviceDataSources(context.plugin.services, service.name, "s3").filter(s => !input.dataSource || s.id === input.dataSource);
    if (!sources.length) continue;
    for (const ns of await deployedNamespaces(service, executor, namespace, context.signal, accessibleNamespaces)) {
      for (const source of sources) targets.push({ namespace: ns, service: service.name, id: source.id });
    }
  }
  if (!targets.length) throw new CommandInputError("没有发现已部署的 S3 数据源；可用 -n 和 -s 指定目标");
  const load = (target: typeof targets[number]) => resolveS3Provider(context,
    { ...input, namespace: target.namespace, dataSource: target.id }, { ...request, service: target.service });
  if (targets.length === 1) return load(targets[0]!);
  const choices = new Map<string, Awaited<ReturnType<typeof resolveS3Provider>>>();
  for (const target of targets) {
    try {
      const provider = await load(target);
      choices.set(`${target.namespace} / ${target.service} / ${request.bucket ?? provider.identity.configuredBucket ?? "(未配置 bucket)"} [${target.id}]`, provider);
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof ParameterCancelled) throw error;
      useLogger("s3").warn(`${target.namespace}/${target.service}/${target.id} 配置不可用`);
    }
  }
  const first = choices.values().next().value;
  const sourceId = first?.dataSource?.id();
  // @rule One resolved data source can address several buckets. Skip selection only for the same probe scope.
  const bucket = request.bucket ?? first?.identity.configuredBucket;
  if (first && sourceId && choices.size > 1 && [...choices.values()].every(provider =>
    provider.dataSource?.id() === sourceId && (request.bucket ?? provider.identity.configuredBucket) === bucket)) {
    const { namespace, service, dataSource } = first.identity;
    useLogger("s3").info(`发现 ${choices.size} 个候选指向同一 S3 探测目标，使用 ${namespace}/${service}/${dataSource}。`);
    return first;
  }
  const choice = await chooseParameter("探测哪个服务使用的 S3 endpoint（可用 -n、-s、--data-source 指定）", [...choices.keys()], canPrompt(input));
  return choices.get(choice)!;
}
