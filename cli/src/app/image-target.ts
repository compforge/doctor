import { createInterface } from "node:readline/promises";
import { prepareTerminalInput } from "../terminal/input";
import { terminalStdout } from "../terminal/output";
import { KubectlExecutor, type Executor } from "../infra/k8s/executor";
import { resolveCollectKubeconfig } from "../infra/k8s/context";
import {
  inspectKubernetesChannel,
  KubernetesAccessContext,
} from "../infra/k8s/access";
import {
  recentSelectionsForInteractive,
  resolveKubernetesRecentScope,
  type KubernetesRecentScope,
  type RecentSelections,
} from "../infra/recent";

export interface ImageKubeOpts {
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
}

export interface RegistryCatalog {
  registries: string[];
  namespacesByRegistry: Record<string, string[]>;
}

interface ImageLocation {
  registry: string;
  namespace: string;
}

type PromptLine = (question: string) => Promise<string | undefined>;

const IMAGE_JSONPATH = [
  "{range .items[*]}",
  "{range .spec.initContainers[*]}{.image}{\"\\n\"}{end}",
  "{range .spec.containers[*]}{.image}{\"\\n\"}{end}",
  "{range .spec.ephemeralContainers[*]}{.image}{\"\\n\"}{end}",
  "{end}",
].join("");

function parseImageLocation(reference: string): ImageLocation | undefined {
  const withoutDigest = reference.trim().split("@", 1)[0];
  if (!withoutDigest) return undefined;
  const parts = withoutDigest.split("/").filter(Boolean);
  if (parts.length === 0) return undefined;

  const hasExplicitRegistry = parts.length > 1
    && (parts[0] === "localhost" || /[.:]/.test(parts[0]!));
  const registry = hasExplicitRegistry ? parts.shift()! : "docker.io";
  const imageName = parts.pop();
  if (!imageName) return undefined;
  const repository = imageName.replace(/:[^:]+$/, "");
  if (!repository) return undefined;

  const namespace = parts.join("/") || (registry === "docker.io" ? "library" : "");
  return { registry, namespace };
}

export function buildRegistryCatalog(images: readonly string[]): RegistryCatalog {
  const namespaces = new Map<string, Set<string>>();
  for (const image of images) {
    const location = parseImageLocation(image);
    if (!location) continue;
    const values = namespaces.get(location.registry) ?? new Set<string>();
    if (location.namespace) values.add(location.namespace);
    namespaces.set(location.registry, values);
  }

  const registries = [...namespaces.keys()].sort((left, right) => left.localeCompare(right));
  return {
    registries,
    namespacesByRegistry: Object.fromEntries(registries.map((registry) => [
      registry,
      [...namespaces.get(registry)!].sort((left, right) => left.localeCompare(right)),
    ])),
  };
}

export async function discoverRegistryCatalog(
  opts: ImageKubeOpts,
  executor?: Executor,
  options: {
    allNamespaces?: boolean;
    access?: KubernetesAccessContext;
    channelChecked?: boolean;
  } = {},
): Promise<RegistryCatalog> {
  const kubeconfig = executor ? undefined : resolveCollectKubeconfig(opts);
  const kubectl = executor ?? new KubectlExecutor({
    kubeconfig: kubeconfig?.kubeconfig,
    context: opts.context,
  });
  const command = (allNamespaces: boolean) => {
    const args = ["--request-timeout=20s", "get", "pods"];
    if (allNamespaces) args.push("-A");
    args.push("-o", `jsonpath=${IMAGE_JSONPATH}`);
    return args;
  };
  const allNamespaces = options.allNamespaces ?? true;
  if (!options.channelChecked && !executor) {
    terminalStdout.write(
      `[k8s] Doctor Host -> Kubernetes: kubeconfig=${kubeconfig?.source ?? "selected"}\n`,
    );
    const channel = await inspectKubernetesChannel(kubectl);
    if (!channel.available) throw new Error(channel.reason ?? "Kubernetes 通道不可用");
    terminalStdout.success("[k8s] Kubernetes API Server 可达\n");
  }
  const access = options.access ?? (!executor ? new KubernetesAccessContext(kubectl) : undefined);
  const permission = access
    ? await access.evaluate({
        command: "doctor image",
        needs: [{
          requirement: "preferred",
          rule: { verb: "list", resource: "pods", allNamespaces },
          purpose: allNamespaces
            ? "从全集群 Pod image 发现 Registry/namespace"
            : "从当前 Namespace Pod image 发现 Registry/namespace",
          fallback: "改为手动输入 Registry/namespace",
        }],
      })
    : undefined;
  const listPods = permission?.facts[0];
  if (listPods?.status === "denied") {
    throw new Error(
      "当前 Kubernetes 凭据明确缺少 list pods 权限，"
      + "无法自动发现 registry 和镜像 namespace",
    );
  }
  // Pod 只用于从现有 image 引用生成 registry/镜像 namespace 候选，发现失败不影响手动发布。
  const result = await kubectl.run(command(allNamespaces), { timeoutMs: 25_000 });
  if (!result.ok) {
    if (/\bforbidden\b/i.test(result.stderr)) {
      const scope = allNamespaces ? "集群级" : "当前 namespace 的";
      throw new Error(
        `当前 Kubernetes 凭据没有${scope} list pods 权限，无法从 Pod 镜像自动发现 registry 和镜像 namespace`,
      );
    }
    const detail = result.stderr.trim() || `kubectl exit ${result.exitCode ?? "unknown"}`;
    throw new Error(`读取当前 Kubernetes 镜像失败（${kubeconfig?.source ?? "selected-namespace"}）：${detail}`);
  }
  return buildRegistryCatalog(result.stdout.split("\n"));
}

async function defaultPrompt(question: string): Promise<string | undefined> {
  prepareTerminalInput();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
}

async function chooseSuggestedValue(input: {
  label: string;
  title: string;
  suggestions: readonly string[];
  defaultValue?: string;
  prompt: PromptLine;
  normalize: (value: string) => string;
}): Promise<string | undefined> {
  if (input.suggestions.length > 0) {
    terminalStdout.info(`${input.title}\n`);
    input.suggestions.forEach((value, index) => terminalStdout.write(`  ${index + 1}) ${value}\n`));
  } else {
    terminalStdout.warning(`[image] 当前 Kubernetes 未发现可用的${input.label} 候选，请手动输入。\n`);
  }

  while (true) {
    const defaultValue = input.defaultValue ?? input.suggestions[0];
    const defaultHint = defaultValue ? `，回车使用 ${defaultValue}` : "";
    const answer = (await input.prompt(
      `选择${input.label}（序号/名称，或直接输入其它值${defaultHint}，q 取消）：`,
    ))?.trim() ?? "";
    if (/^(q|quit)$/i.test(answer)) return undefined;
    if (!answer && defaultValue) return defaultValue;
    if (/^\d+$/.test(answer)) {
      const selected = input.suggestions[Number(answer) - 1];
      if (selected) return selected;
      terminalStdout.warning("输入无效，请选择候选序号或直接输入其它值。\n");
      continue;
    }
    const suggested = input.suggestions.find((value) => value.toLowerCase() === answer.toLowerCase());
    if (suggested) return suggested;
    const normalized = input.normalize(answer);
    if (normalized) return normalized;
    terminalStdout.warning(`${input.label.trim()} 不能为空。\n`);
  }
}

interface ResolveImageTargetOptions {
  interactive?: boolean;
  discover?: () => Promise<RegistryCatalog>;
  prompt?: PromptLine;
  recent?: RecentSelections;
}

function sourceRepositoryAndTag(sourceImage: string): string {
  const leaf = sourceImage.trim().split("/").pop() ?? "";
  const colon = leaf.lastIndexOf(":");
  if (colon <= 0 || colon === leaf.length - 1) {
    throw new Error(`无法从 tar image 推断目标 repository:tag：${sourceImage}；请显式传 doctor image <image>`);
  }
  return leaf;
}

export async function resolveImageTarget(
  explicit: string | undefined,
  sourceImage: string,
  opts: ImageKubeOpts,
  options: ResolveImageTargetOptions = {},
): Promise<string | undefined> {
  if (explicit) {
    terminalStdout.info(`[image] target: ${explicit}（命令参数）\n`);
    return explicit;
  }
  const interactive = options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error("未指定目标 registry image；请传 doctor image <image>");
  }
  const repositoryAndTag = sourceRepositoryAndTag(sourceImage);
  const recent = recentSelectionsForInteractive(options.interactive, options.recent);
  let recentScope: KubernetesRecentScope | undefined;
  if (recent) {
    try {
      recentScope = resolveKubernetesRecentScope({
        kubeconfig: resolveCollectKubeconfig(opts).kubeconfig,
        context: opts.context,
      });
    } catch {
      // Registry target selection can fall back to manual input even without a usable profile.
      recentScope = resolveKubernetesRecentScope(opts);
    }
  }

  let catalog: RegistryCatalog = { registries: [], namespacesByRegistry: {} };
  try {
    catalog = await (options.discover ?? (() => discoverRegistryCatalog(opts)))();
  } catch (err) {
    terminalStdout.warning(`[image] ${err instanceof Error ? err.message : String(err)}；改为手动输入。\n`);
  }
  const prompt = options.prompt ?? defaultPrompt;
  const registries = recent
    ? recent.rankImageRegistries(recentScope!, catalog.registries)
    : catalog.registries;
  const registry = await chooseSuggestedValue({
    label: " registry",
    title: "[image] 当前 Kubernetes 集群使用的 registry：",
    suggestions: registries,
    defaultValue: catalog.registries[0],
    prompt,
    normalize: (value) => value.replace(/\/+$/, "").trim(),
  });
  if (!registry) return undefined;

  const namespaces = recent
    ? recent.rankImageNamespaces(
        recentScope!,
        registry,
        catalog.namespacesByRegistry[registry] ?? [],
      )
    : catalog.namespacesByRegistry[registry] ?? [];
  const namespace = await chooseSuggestedValue({
    label: "镜像 namespace",
    title: `[image] registry ${registry} 下已使用的镜像 namespace：`,
    suggestions: namespaces,
    defaultValue: catalog.namespacesByRegistry[registry]?.[0],
    prompt,
    normalize: (value) => value.replace(/^\/+|\/+$/g, "").trim(),
  });
  if (!namespace) return undefined;

  if (recent && recentScope) recent.recordImageTarget(recentScope, { registry, namespace });
  const image = `${registry}/${namespace}/${repositoryAndTag}`;
  terminalStdout.info(`[image] target: ${image}\n`);
  return image;
}
