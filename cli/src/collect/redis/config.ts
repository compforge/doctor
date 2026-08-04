import { terminalStdout } from "../../terminal/output";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveProfile } from "../../app/config/config";
import type { RedisProfileConfig } from "../../app/config/model";
import type { Executor } from "../../infra/k8s/executor";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  resolvePodTarget,
  type KubernetesCommandConfig,
  type KubernetesCommandInput,
  type PodTarget,
} from "../../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import type { ServiceCatalog } from "@compforge/doctor-plugin";
import { serviceStores, servicesWithStore } from "@compforge/doctor-plugin";
import type { ServiceRedisStoreCapability } from "@compforge/doctor-plugin";
import { listServiceChoices } from "../../infra/k8s/service-selection";
import {
  matchListedChoice,
  printNumberedChoices,
  promptListedChoice,
} from "../../terminal/selection";

export const REDIS_DEFAULTS = {
  maxKeys: 10_000,
  maxKeysPerSecond: 500,
  scanCount: 100,
  pipelineKeys: 50,
  top: 20,
  showKeyNames: true,
} as const;

export type RedisOutputFormat = "bundle" | "html" | "md";

export interface RedisConfig {
  collect: KubernetesCommandConfig;
  target: PodTarget;
  profileName: string;
  profile?: RedisProfileConfig;
  service?: string;
  store?: ServiceRedisStoreCapability;
  url?: string;
  database?: number;
  scan: {
    mode: "quick" | "sample";
    maxKeys: number;
    maxKeysPerSecond: number;
    scanCount: number;
    pipelineKeys: number;
    top: number;
    showKeyNames: boolean;
    keyStats: boolean;
  };
  outputFormat: RedisOutputFormat;
  output?: string;
  deferDelivery?: boolean;
}

export interface RedisConfigInput extends KubernetesCommandInput {
  service?: string;
  store?: string;
  url?: string;
  database?: string;
  pod?: string;
  container?: string;
  quick?: boolean;
  maxKeys: string;
  maxKeysPerSecond: string;
  top: string;
  showKeyNames?: boolean;
  keystats?: boolean;
  format?: string;
  output?: string;
  deferDelivery?: boolean;
}

async function resolveRedisCatalogStore(input: {
  requestedService?: string;
  requestedStore?: string;
  podKeyword?: string;
  catalog?: ServiceCatalog;
  executor: Executor;
  namespace: string;
}): Promise<{ service: string; store: ServiceRedisStoreCapability } | undefined> {
  if (!input.catalog) return undefined;
  const explicitService = input.requestedService?.trim();
  const deployed = new Set(
    (await listServiceChoices(input.executor, input.namespace)).map((service) => service.name),
  );
  const candidates = servicesWithStore(input.catalog, "redis")
    .filter((service) => deployed.has(service.name))
    .map((service) => ({ name: service.name }));
  if (candidates.length === 0) {
    throw new Error(`namespace '${input.namespace}' 中没有已部署且声明 Redis Store capability 的 Service`);
  }
  let service = explicitService;
  if (service) {
    if (!candidates.some((candidate) => candidate.name === service)) {
      throw new Error(`Service '${service}' 未部署或未声明 Redis Store capability`);
    }
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("非交互终端请用 --service <name> 或 --pod <pod> 指定 Redis 配置来源");
    }
    printNumberedChoices(candidates, "[collect] 可提供 Redis 配置的 Service：", (candidate) => candidate.name);
    service = await promptListedChoice({
      question: "请选择 Service（序号或名称，q 取消）：",
      match: (answer) => matchListedChoice(
        candidates,
        answer,
        (candidate) => candidate.name,
        (candidate) => candidate.name,
      ),
      invalidMessage: "请输入有效的序号或名称。",
    });
    if (!service) return undefined;
  }
  const stores = serviceStores(input.catalog, service, "redis") as readonly ServiceRedisStoreCapability[];
  const requestedStore = input.requestedStore?.trim();
  let store = requestedStore ? stores.find((candidate) => candidate.id === requestedStore) : undefined;
  if (requestedStore && !store) {
    throw new Error(`Service '${service}' 未声明 Redis Store '${requestedStore}'`);
  }
  if (!store && stores.length === 1) store = stores[0];
  if (!store) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(`Service '${service}' 声明了多个 Redis Store；请用 --store <id> 指定`);
    }
    const choices = stores.map((candidate) => ({ name: candidate.id }));
    printNumberedChoices(choices, `[collect] Service '${service}' 的 Redis Store：`, (candidate) => candidate.name);
    const selected = await promptListedChoice({
      question: "请选择 Redis Store（序号或名称，q 取消）：",
      match: (answer) => matchListedChoice(
        choices,
        answer,
        (candidate) => candidate.name,
        (candidate) => candidate.name,
      ),
      invalidMessage: "请输入有效的序号或名称。",
    });
    store = stores.find((candidate) => candidate.id === selected);
  }
  return store ? { service, store } : undefined;
}

function parseIntegerFlag(name: string, value: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} 需要 >= ${minimum} 的整数: '${value}'`);
  }
  return parsed;
}

export function parseRedisOutputFormat(value: string | undefined): RedisOutputFormat {
  const format = value?.trim() || "html";
  if (format !== "bundle" && format !== "html" && format !== "md") {
    throw new Error(`--format 只支持 bundle、html 或 md: '${format}'`);
  }
  return format;
}

export async function resolveRedisConfig(
  input: RedisConfigInput,
  injectedExecutor?: Executor,
  commandContext?: CommandContext,
  catalog?: ServiceCatalog,
): Promise<{ config: RedisConfig; executor: Executor } | undefined> {
  const maxKeys = parseIntegerFlag("--max-keys", input.maxKeys, 1);
  const maxKeysPerSecond = parseIntegerFlag("--max-keys-per-second", input.maxKeysPerSecond, 1);
  const top = parseIntegerFlag("--top", input.top, 1);
  const database = input.database === undefined
    ? undefined
    : parseIntegerFlag("--database", input.database, 0);
  const outputFormat = parseRedisOutputFormat(input.format);

  const configPath = input.config
    ?? process.env.DOCTOR_CONFIG
    ?? join(homedir(), ".doctor", "config.yaml");
  const resolvedProfile = resolveProfile(loadConfig(configPath), input.profile);
  const redisProfile = resolvedProfile.profile.redis;
  let podKeyword = input.pod?.trim()
    || (!catalog ? redisProfile?.pod?.trim() || redisProfile?.deployment?.trim() : undefined);

  const collect = await resolveKubernetesCommandConfig(
    input,
    injectedExecutor,
    commandContext,
  );
  if (!collect) return undefined;
  terminalStdout.write(
    `[collect] namespace: ${collect.kubernetes.namespace}（${collect.kubernetes.namespaceSource}）\n`,
  );
  const executor = injectedExecutor ?? createKubernetesExecutor(collect);
  const access = resolveKubernetesCommandContext(executor, commandContext).access;
  await enforceKubernetesAccess(access, {
    command: "doctor store",
    needs: [{
      requirement: "required",
      rule: { verb: "create", resource: "pods/exec" },
      purpose: "读取目标 Container 的 Redis 运行时配置",
    }],
  });
  const catalogStore = await resolveRedisCatalogStore({
    requestedService: input.service,
    requestedStore: input.store,
    podKeyword,
    catalog,
    executor,
    namespace: collect.kubernetes.namespace,
  });
  if (catalogStore && input.url?.trim()) {
    throw new Error("doctor store 的 Redis 访问地址与凭据来自所选 Service；不支持 --url 覆盖");
  }
  if (catalog && !catalogStore) return undefined;
  podKeyword ||= catalogStore?.service;
  const target = await resolvePodTarget({
    config: collect,
    executor,
    pod: podKeyword,
    container: input.container,
    selectContainer: true,
    access,
  });
  if (!target) return undefined;

  return {
    config: {
      collect,
      target,
      profileName: resolvedProfile.name,
      profile: catalogStore ? undefined : redisProfile,
      service: catalogStore?.service,
      store: catalogStore?.store,
      url: catalogStore ? undefined : input.url,
      database,
      scan: {
        mode: input.quick ? "quick" : "sample",
        maxKeys,
        maxKeysPerSecond,
        scanCount: REDIS_DEFAULTS.scanCount,
        pipelineKeys: REDIS_DEFAULTS.pipelineKeys,
        top,
        showKeyNames: input.showKeyNames ?? REDIS_DEFAULTS.showKeyNames,
        keyStats: !!input.keystats,
      },
      outputFormat,
      output: input.output,
      deferDelivery: input.deferDelivery,
    },
    executor,
  };
}
