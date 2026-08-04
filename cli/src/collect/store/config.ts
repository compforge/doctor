import type { PluginDefinition } from "@compforge/doctor-plugin";
import { serviceStores, servicesWithStore } from "@compforge/doctor-plugin";
import type {
  ServiceStoreCapability,
} from "@compforge/doctor-plugin";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  resolvePodTarget,
  type KubernetesCommandConfig,
  type KubernetesCommandInput,
  type PodTarget,
} from "../../command/kubernetes-target";
import {
  resolveKubernetesCommandContext,
  type CommandContext,
} from "../../command";
import type { Executor } from "../../infra/k8s/executor";
import { KubectlPodLogAccess } from "../../infra/k8s/pod-log";
import { parsePodChoices, promptPod } from "../../infra/k8s/pod-selection";
import { listServiceChoices } from "../../infra/k8s/service-selection";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import {
  matchListedChoice,
  printNumberedChoices,
  promptListedChoice,
} from "../../terminal/selection";
import { terminalStdout } from "../../terminal/output";
import { promptNamedChoices } from "../../terminal/service-selection";
import { resolveArchivePath } from "../output/archive";
import { join } from "node:path";

export const STORE_KINDS = ["db", "vdb", "s3", "redis"] as const;
export type DiagnosableStoreKind = typeof STORE_KINDS[number];
type NativeStoreKind = Exclude<DiagnosableStoreKind, "redis">;
export type StoreOutputFormat = "bundle" | "html" | "md";

export interface CollectStoreCliOpts extends KubernetesCommandInput {
  type?: string;
  service?: string;
  store?: string;
  pod?: string;
  container?: string;
  backendService?: string;
  endpoint?: string;
  s3Prefix?: string;
  s3MaxObjects?: string;
  s3ScanTimeout?: string;
  output?: string;
  database?: string;
  quick?: boolean;
  keystats?: boolean;
  maxKeys?: string;
  maxKeysPerSecond?: string;
  top?: string;
  showKeyNames?: boolean;
  format?: string;
  deferDelivery?: boolean;
}

export interface StoreConfig {
  collect: KubernetesCommandConfig;
  service: string;
  capability: ServiceStoreCapability;
  target: PodTarget;
  backendService?: string;
  endpoint?: string;
  s3Prefix?: string;
  s3MaxObjects: number;
  s3ScanTimeoutMs: number;
  outputFormat: StoreOutputFormat;
  output?: string;
  deferDelivery?: boolean;
}

export interface ResolvedStoreConfig {
  config: StoreConfig;
  executor: Executor;
}

export function parseStoreKinds(value: string | undefined): DiagnosableStoreKind[] {
  if (!value?.trim()) return [];
  const normalized = [...new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
  const unsupported = normalized.filter((item) => !STORE_KINDS.includes(item as DiagnosableStoreKind));
  if (unsupported.length) {
    throw new Error(`--type 只支持 ${STORE_KINDS.join("、")}: '${unsupported.join(",")}'`);
  }
  return normalized as DiagnosableStoreKind[];
}

export function parseStoreOutputFormat(value: string | undefined): StoreOutputFormat {
  const format = value?.trim() || "html";
  if (format !== "bundle" && format !== "html" && format !== "md") {
    throw new Error(`--format 只支持 bundle、html 或 md: '${format}'`);
  }
  return format;
}

export function resolveStoreOutputPath(
  output: string | undefined,
  artifactName: string,
  format: StoreOutputFormat,
): string {
  if (format === "bundle") {
    if (/\.(?:html|md)$/i.test(output ?? "")) {
      throw new Error("--format bundle 的输出路径不能使用 .html/.md 后缀");
    }
    return resolveArchivePath(output, artifactName);
  }
  if (format === "html") {
    if (!output) return join(".", `${artifactName}.html`);
    if (/\.(?:tar\.gz|tgz|md)$/i.test(output)) {
      throw new Error("--format html 的输出路径不能使用 .tar.gz/.tgz/.md 后缀");
    }
    return output.toLowerCase().endsWith(".html") ? output : `${output}.html`;
  }
  if (!output) return join(".", `${artifactName}.md`);
  if (/\.(?:tar\.gz|tgz|html)$/i.test(output)) {
    throw new Error("--format md 的输出路径不能使用 .tar.gz/.tgz/.html 后缀");
  }
  return output.toLowerCase().endsWith(".md") ? output : `${output}.md`;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} 需要正整数: '${value}'`);
  return parsed;
}

async function selectOne<T extends { name: string }>(
  choices: readonly T[],
  title: string,
  question: string,
): Promise<string | undefined> {
  printNumberedChoices(choices, title, (choice) => choice.name);
  return promptListedChoice({
    question,
    match: (answer) => matchListedChoice(choices, answer, (choice) => choice.name, (choice) => choice.name),
    invalidMessage: "请输入有效的序号或名称。",
  });
}

export async function resolveStoreKinds(
  requested: string | undefined,
  plugin: PluginDefinition,
  interactive: boolean,
): Promise<DiagnosableStoreKind[] | undefined> {
  const explicit = parseStoreKinds(requested);
  if (explicit.length) return explicit;
  const choices = STORE_KINDS
    .filter((kind) => servicesWithStore(plugin.services, kind).length)
    .map((name) => ({ name }));
  if (!interactive) throw new Error(`非交互终端请用 --type <${choices.map((item) => item.name).join(",")}> 指定 Store 类型`);
  const selected = await promptNamedChoices(choices, [], "[collect] 请选择本次要诊断的 Store 类型：");
  return selected?.length ? selected as DiagnosableStoreKind[] : undefined;
}

async function resolveService(
  requested: string | undefined,
  kind: NativeStoreKind,
  plugin: PluginDefinition,
  executor: Executor,
  namespace: string,
  interactive: boolean,
): Promise<string | undefined> {
  const deployed = new Set((await listServiceChoices(executor, namespace)).map((service) => service.name));
  const choices = servicesWithStore(plugin.services, kind)
    .filter((service) => deployed.has(service.name))
    .map((service) => ({ name: service.name }));
  if (!choices.length) throw new Error(`namespace '${namespace}' 中没有声明且已部署的 ${kind} Store Service`);
  const explicit = requested?.trim();
  if (explicit) {
    if (!choices.some((choice) => choice.name === explicit)) {
      throw new Error(`Service '${explicit}' 未部署或未声明 ${kind} Store capability`);
    }
    return explicit;
  }
  if (choices.length === 1) {
    terminalStdout.write(`[collect] service: ${choices[0]!.name}（唯一 ${kind} provider，自动选择）\n`);
    return choices[0]!.name;
  }
  if (!interactive) throw new Error(`非交互终端请用 --service <name> 指定 ${kind} 配置来源 Service`);
  return selectOne(choices, `[collect] 可提供 ${kind} 配置的 Service：`, "请选择 Service（序号或名称，q 取消）：");
}

async function resolveCapability(
  service: string,
  kind: NativeStoreKind,
  requested: string | undefined,
  plugin: PluginDefinition,
  interactive: boolean,
): Promise<ServiceStoreCapability | undefined> {
  const choices = serviceStores(plugin.services, service, kind);
  const explicit = requested?.trim();
  if (explicit) {
    const capability = choices.find((choice) => choice.id === explicit);
    if (!capability) throw new Error(`Service '${service}' 未声明 ${kind} Store '${explicit}'`);
    return capability;
  }
  if (choices.length === 1) return choices[0];
  if (!interactive) throw new Error(`Service '${service}' 声明了多个 ${kind} Store；请用 --store <id> 指定`);
  const selected = await selectOne(
    choices.map((choice) => ({ name: choice.id })),
    `[collect] Service '${service}' 的 ${kind} Store：`,
    "请选择 Store（序号或名称，q 取消）：",
  );
  return choices.find((choice) => choice.id === selected);
}

async function resolveServicePod(input: {
  service: string;
  pod?: string;
  executor: Executor;
  namespace: string;
  interactive: boolean;
}): Promise<string | undefined> {
  const access = new KubectlPodLogAccess(input.executor, input.namespace);
  const listed = await access.listServicePods([input.service]);
  if (!listed.serviceCapture.ok || !listed.podCapture.ok || listed.parseError) {
    const reason = listed.parseError
      ?? (!listed.serviceCapture.ok ? listed.serviceCapture.stderr : listed.podCapture.stderr).trim();
    throw new Error(`读取 Service/Pod 候选失败：${reason || "unknown error"}`);
  }
  const names = listed.byService[input.service] ?? [];
  const choices = parsePodChoices(listed.podCapture.stdout).filter((pod) => names.includes(pod.name));
  const explicit = input.pod?.trim();
  if (explicit) {
    if (!names.includes(explicit)) throw new Error(`Service '${input.service}' 的 Running Pod 中不存在 '${explicit}'`);
    return explicit;
  }
  if (!choices.length) throw new Error(`Service '${input.service}' 没有 Running Pod`);
  if (choices.length === 1) {
    terminalStdout.write(`[collect] pod: ${choices[0]!.name}（唯一 Running Pod，自动选择）\n`);
    return choices[0]!.name;
  }
  if (!input.interactive) throw new Error(`Service '${input.service}' 有多个 Running Pod；请用 --pod <pod> 指定`);
  return promptPod(choices);
}

export async function resolveStoreConfig(
  opts: CollectStoreCliOpts,
  plugin: PluginDefinition,
  commandContext?: CommandContext,
): Promise<ResolvedStoreConfig | undefined> {
  const outputFormat = parseStoreOutputFormat(opts.format);
  // 在访问现场前校验显式输出后缀，避免完成采集后才发现产物路径不可用。
  resolveStoreOutputPath(opts.output, "doctor-store", outputFormat);
  const collect = await resolveKubernetesCommandConfig(opts, undefined, commandContext);
  if (!collect) return undefined;
  const executor = createKubernetesExecutor(collect);
  const access = resolveKubernetesCommandContext(executor, commandContext).access;
  await enforceKubernetesAccess(access, {
    command: "doctor store",
    needs: [
      { requirement: "required", rule: { verb: "list", resource: "services" }, purpose: "选择 Store 配置来源 Service" },
      { requirement: "required", rule: { verb: "list", resource: "pods" }, purpose: "选择 Service 的 Running Pod" },
      { requirement: "preferred", rule: { verb: "get", resource: "configmaps" }, purpose: "读取 Service 声明引用的 Store 配置", fallback: "回退读取 Container 运行时 env" },
      { requirement: "preferred", rule: { verb: "get", resource: "secrets" }, purpose: "读取 Service 声明引用的 Store 凭据", fallback: "回退读取 Container 运行时 env" },
      { requirement: "preferred", rule: { verb: "create", resource: "pods/exec" }, purpose: "声明配置不足时读取 Container 运行时 env", fallback: "配置不足时标记 Store unavailable" },
    ],
  });
  return resolveStoreProviderConfig(opts, plugin, collect, executor, commandContext, outputFormat);
}

/** 已建立 Kubernetes 通道时，复用 Store 的 Service/capability/Pod 选择与配置来源定位。 */
export async function resolveStoreProviderConfig(
  opts: CollectStoreCliOpts,
  plugin: PluginDefinition,
  collect: KubernetesCommandConfig,
  executor: Executor,
  commandContext?: CommandContext,
  resolvedOutputFormat?: StoreOutputFormat,
): Promise<ResolvedStoreConfig | undefined> {
  const outputFormat = resolvedOutputFormat ?? parseStoreOutputFormat(opts.format);
  resolveStoreOutputPath(opts.output, "doctor-store", outputFormat);
  const access = resolveKubernetesCommandContext(executor, commandContext).access;
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
  const [kind] = parseStoreKinds(opts.type);
  if (!kind || kind === "redis") throw new Error("resolveStoreConfig 只处理 db、vdb、s3 单个 Store");
  const namespace = collect.kubernetes.namespace;
  const service = await resolveService(opts.service, kind, plugin, executor, namespace, interactive);
  if (!service) return undefined;
  const capability = await resolveCapability(service, kind, opts.store, plugin, interactive);
  if (!capability) return undefined;
  const pod = await resolveServicePod({ service, pod: opts.pod, executor, namespace, interactive });
  if (!pod) return undefined;
  const target = await resolvePodTarget({
    config: collect,
    executor,
    pod,
    container: opts.container,
    selectContainer: true,
    interactive,
    access,
  });
  if (!target) return undefined;
  return {
    config: {
      collect,
      service,
      capability,
      target,
      backendService: opts.backendService?.trim() || undefined,
      endpoint: opts.endpoint?.trim() || undefined,
      s3Prefix: opts.s3Prefix,
      s3MaxObjects: positiveInteger(opts.s3MaxObjects, 100_000, "--s3-max-objects"),
      s3ScanTimeoutMs: positiveInteger(opts.s3ScanTimeout, 120, "--s3-scan-timeout") * 1000,
      outputFormat,
      output: opts.output,
      deferDelivery: opts.deferDelivery,
    },
    executor,
  };
}
