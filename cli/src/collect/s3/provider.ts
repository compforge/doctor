import { serviceDataSources, servicesWithDataSource } from "@compforge/doctor-plugin";
import { CommandInputError, resolveKubernetesCommandContext, type CommandContext } from "../../command";
import { createKubernetesExecutor, resolveKubernetesCommandConfig } from "../../command/kubernetes-target";
import { prepareS3Access, resolveS3Configuration } from "../../datasource/s3";
import { resolveDataSourceTarget } from "../../datasource/workload";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import { canPrompt, chooseParameter, ParameterCancelled } from "../../terminal/parameters";
import type { S3Input, S3Request } from "./input";

export async function resolveS3Provider(context: CommandContext, input: S3Input, request: S3Request) {
  const interactive = canPrompt({ interactive: input.interactive });
  const services = servicesWithDataSource(context.plugin.services, "s3").map(service => service.name);
  const requested = request.service ?? await chooseParameter("--service", services, interactive);
  const service = context.plugin.services.find(requested)?.name ?? requested;
  if (!services.includes(service)) throw new CommandInputError(`Service '${service}' 未声明 S3 DataSource`);
  const capabilities = serviceDataSources(context.plugin.services, service, "s3");
  const id = input.dataSource ?? await chooseParameter("--data-source", capabilities.map(source => source.id), interactive);
  const capability = capabilities.find(source => source.id === id);
  if (!capability || capability.kind !== "s3") throw new CommandInputError(`Service '${service}' 未声明 S3 DataSource '${id}'`);
  await context.ensureEnvironment({ kubernetes: true });
  const collect = await resolveKubernetesCommandConfig({ ...input, ...context.options.environment,
    profile: context.profile.name, interactive }, undefined, context);
  if (!collect) throw new ParameterCancelled();
  const executor = createKubernetesExecutor(collect);
  let target;
  if (!capability.source) {
    await enforceKubernetesAccess(resolveKubernetesCommandContext(executor, context).access, {
      command: "doctor s3", needs: [
        { requirement: "preferred", rule: { verb: "get", resource: "configmaps" }, purpose: "读取 S3 配置", fallback: "读取 Container env" },
        { requirement: "preferred", rule: { verb: "get", resource: "secrets" }, purpose: "读取 S3 凭据", fallback: "读取 Container env" },
        { requirement: "preferred", rule: { verb: "create", resource: "pods/exec" }, purpose: "补充 S3 运行时配置", fallback: "标记数据源 unavailable" },
      ],
    });
    target = await resolveDataSourceTarget({ service: context.plugin.services.find(service)!,
      pod: input.pod, container: input.container, executor, namespace: collect.kubernetes.namespace,
      interactive, commandContext: context,
      selection: { candidateRole: "配置来源", purpose: `读取 Service '${service}' 的 S3 配置`, effect: "配置来源不限制 bucket 查询范围。" },
    });
    if (!target) throw new ParameterCancelled();
  }
  const resolved = await resolveS3Configuration(context, { collect, service, capability, target }, executor);
  if (!resolved.target) throw new Error(resolved.reason ?? "未解析到 S3 目标");
  const access = await prepareS3Access(context, collect, resolved.target, resolved.client);
  const endpoint = new URL(resolved.target.endpoint);
  endpoint.username = ""; endpoint.password = ""; endpoint.search = ""; endpoint.hash = "";
  return { client: access.client, identity: {
    service, dataSource: capability.id, description: capability.description,
    endpoint: endpoint.toString(), region: resolved.target.region,
    configuredBucket: resolved.bucket, configuredPrefix: resolved.bucketPrefix,
    source: resolved.source, namespace: collect.kubernetes.namespace, pod: target?.pod, container: target?.container,
    channel: access.channel, executionLocation: "doctor-host",
  } };
}
