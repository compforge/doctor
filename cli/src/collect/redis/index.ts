import { terminalStdout, terminalStderr } from "../../terminal/output";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reportError, writeErrorLog } from "../../app/error-log";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { runDiagnosis } from "../engine";
import { EvidenceBundle, type OutcomeDecl } from "../evidence";
import { runInspects } from "../inspect-engine";
import type { Executor } from "../../infra/k8s/executor";
import type { RedisAccessApi } from "../../infra/redis";
import type { CommandContext } from "../../command";
import type { ServiceCatalog } from "@compforge/doctor-plugin";
import { packBundle, resolveArchivePath } from "../output/archive";
import { deliverFailureBundle } from "../output/failure-bundle";
import { evaluateCollectOutcome } from "../outcome";
import { htmlPieCharts, htmlPieChartSection, writeHtmlReport, type HtmlPieChart } from "../output/html";
import type { RedisCollectContext } from "./context";
import { buildRedisCoverage, redisDetectors } from "./detector";
import { makeRedisInspect, sanitizeRedisTarget } from "./fact/inspect";
import type { RedisInspectionFacts } from "./fact/model";
import {
  buildRedisEvidence,
  type RedisDiagnosis,
} from "./model";
import {
  makeRedisPressureProbe,
  makeRedisRuntimeProbe,
  makeRedisKeyStatsProbe,
} from "./probe/runtime";
import { discoverRedisDatabases } from "./probe/collector";
import { confirmRedisTarget, prepareRedisAccess } from "./preparation";
import {
  buildRedisHtml,
  buildRedisKeyDistributionHtml,
  buildRedisKeyStatsHtml,
  buildRedisMarkdown,
  buildRedisPrefixKeyPieCharts,
  buildRedisPrefixMemoryPieCharts,
  buildRedisTtlPieCharts,
} from "./render";
import {
  REDIS_DEFAULTS,
  parseRedisOutputFormat,
  resolveRedisConfig,
  selectRedisDatabaseScope,
  type RedisOutputFormat,
} from "./config";

export { REDIS_DEFAULTS, parseRedisOutputFormat } from "./config";
export { hasRedisStoreConfiguration, projectRedisStoreEnvironment } from "./fact/target";

export interface CollectRedisCliOpts {
  service?: string;
  store?: string;
  url?: string;
  database?: string;
  pod?: string;
  container?: string;
  namespace?: string;
  quick?: boolean;
  keystats?: boolean;
  maxKeys: string;
  maxKeysPerSecond: string;
  top: string;
  showKeyNames?: boolean;
  format?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  output?: string;
}

const REDIS_OUTPUT_LABELS: Record<RedisOutputFormat, string> = {
  bundle: "证据包",
  html: "HTML 报告",
  md: "Markdown 报告",
};

function redisBundleName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `doctor-redis-${timestamp}`;
}

export function resolveRedisOutputPath(
  output: string | undefined,
  bundleName: string,
  format: RedisOutputFormat,
): string {
  if (format === "bundle") {
    if (/\.(?:html|md)$/i.test(output ?? "")) {
      throw new Error("--format bundle 的输出路径不能使用 .html/.md 后缀");
    }
    return resolveArchivePath(output, bundleName);
  }
  if (format === "html") {
    if (!output) return join(".", `${bundleName}.html`);
    if (/\.(?:tar\.gz|tgz|md)$/i.test(output)) {
      throw new Error("--format html 的输出路径不能使用 .tar.gz/.tgz/.md 后缀");
    }
    return output.toLowerCase().endsWith(".html") ? output : `${output}.html`;
  }
  if (!output) return join(".", `${bundleName}.md`);
  if (/\.(?:tar\.gz|tgz|html)$/i.test(output)) {
    throw new Error("--format md 的输出路径不能使用 .tar.gz/.tgz/.html 后缀");
  }
  return output.toLowerCase().endsWith(".md") ? output : `${output}.md`;
}

/**
 * 本次采集打算拿到的证据（检验项）。目标、能力、基础 Probe、自适应 keyStats 与压力 Probe
 * 层层递进，最后才基于本轮实际取得的 Observation 判读结论。
 *
 * 预印在这里，是为了让"没做"和"没记"长得不一样：以前 capability 不可用时
 * redis-probe 与 redis-findings 整个不进 manifest——核心那份证据连"为什么没有"
 * 都查不到，只有 summary.md（给人看）写了一句。
 *
 * 注：redis 领域另有一套 coverage 机制声明"quick 模式不做 keyspace 抽样"，那套是对的、
 * 不动；但它只在诊断主链成功后才产生，探针一失败连缺席声明本身都没了——这层由单子兜。
 */
const REDIS_OUTCOMES: readonly OutcomeDecl[] = [
  { id: "resolve-target", title: "解析 Redis 目标（已移除凭据）", risk: "observe" },
  { id: "access-preparation", title: "准备 Redis 本机访问通道", risk: "observe" },
  { id: "capability", title: "Redis TS 客户端连通性检查", risk: "observe" },
  { id: "redis-probe", title: "Redis 拓扑、容量与 key 分布探测", risk: "observe" },
  { id: "redis-key-stats", title: "Redis master keyStats 深度探测", risk: "observe" },
  { id: "redis-pressure-1s", title: "Redis 1 秒 eviction / OOM 观察", risk: "observe" },
  { id: "redis-pressure-10s", title: "Redis 10 秒 eviction / OOM 观察", risk: "observe" },
  { id: "redis-findings", title: "Redis 确定性规则判读", risk: "observe" },
];

/**
 * injectedExecutor 只为测试注入——对齐 collectMemory(opts, exec, log) 的形状。
 * 在此之前 redis 的执行器是内部 new 的，导致降级路径（capability 不可用、探针失败）
 * 无法端到端验证，而那正是记账出问题的地方。
 */
export async function runCollectRedis(
  opts: CollectRedisCliOpts,
  injectedExecutor?: Executor,
  injectedAccess?: RedisAccessApi,
  commandContext?: CommandContext,
  catalog?: ServiceCatalog,
): Promise<number> {
  let resolved;
  try {
    resolved = await resolveRedisConfig(opts, injectedExecutor, commandContext, catalog);
  } catch (err) {
    terminalStderr.error(`[collect] ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (!resolved) {
    terminalStderr.warning("[collect] 已取消\n");
    return 130;
  }
  const { config, executor } = resolved;
  const namespace = config.collect.kubernetes.namespace;
  const pod = config.target.pod;
  const container = config.target.container;
  const { mode, maxKeys, maxKeysPerSecond, top, keyStats } = config.scan;
  const format = config.outputFormat;
  const bundleName = redisBundleName(new Date());
  let outputPath: string;
  try {
    outputPath = resolveRedisOutputPath(config.output, bundleName, format);
  } catch (err) {
    terminalStderr.error(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  terminalStdout.write(`[collect] Redis scan mode: ${mode}\n`);
  terminalStdout.write(`[collect] Redis output format: ${format}\n`);
  if (mode === "quick") {
    terminalStdout.write("[collect] Redis scan limit: 基础探针不扫描 key\n");
  } else {
    terminalStdout.write(`[collect] Redis scan limit: 最多 ${maxKeys} 个 key（在 master/DB 间均分）\n`);
    terminalStdout.write(`[collect] Redis scan rate: 最多 ${maxKeysPerSecond} key/s\n`);
  }
  if (keyStats) terminalStdout.write("[collect] Redis keyStats: 强制检查所有 master\n");
  const staging = join(mkdtempSync(join(tmpdir(), "doctor-redis-")), bundleName);
  const bundle = new EvidenceBundle(staging, REDIS_OUTCOMES);
  const startedAt = new Date().toISOString();
  const collectContext: RedisCollectContext = {
    exec: executor,
    execTarget: { pod, container },
    bundle,
    log: (line) => terminalStdout.write(`${line}\n`),
  };
  let summaryHtml = "<h1>Redis 诊断未形成结果</h1><p>失败原因与已取得证据见采集步骤和原始证据。</p>";
  let keyDistributionHtml = "";
  let keyStatsHtml = "";
  let prefixKeyPieCharts: HtmlPieChart[] = [];
  let prefixMemoryPieCharts: HtmlPieChart[] = [];
  let ttlPieCharts: HtmlPieChart[] = [];
  const inspectionFacts: Record<string, unknown> = {};

  const finish = async (target: Record<string, unknown>, code: number) => {
    const closePreparation = collectContext.closePreparation;
    collectContext.closePreparation = undefined;
    await closePreparation?.();
    bundle.writeManifest({
      doctorVersion: DOCTOR_CLI_VERSION,
      target,
      inspectionFacts,
      params: {
        namespace,
        pod,
        container,
        service: config.service ?? null,
        store: config.store?.id ?? null,
        profile: config.profileName,
        mode,
        max_keys: maxKeys,
        max_keys_per_second: maxKeysPerSecond,
        scan_count: config.scan.scanCount,
        pipeline_keys: config.scan.pipelineKeys,
        top,
        show_key_names: config.scan.showKeyNames,
        key_stats: config.scan.keyStats,
        connection_database: collectContext.redisTarget?.database ?? null,
        database_scope: collectContext.redisDatabaseScope?.mode ?? null,
        databases: collectContext.redisDatabaseScope?.databases ?? [],
        database: collectContext.redisDatabaseScope?.mode === "single"
          ? collectContext.redisDatabaseScope.databases[0] ?? null
          : null,
        output_format: format,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    if (code === 130) {
      rmSync(join(staging, ".."), { recursive: true, force: true });
      return 130;
    }
    if (code !== 0) {
      const failure = await deliverFailureBundle({
        bundleDir: staging,
        bundleName,
        requestedOutput: config.output,
        collectCode: code,
      });
      if (failure.packed.ok) {
        rmSync(join(staging, ".."), { recursive: true, force: true });
        if (!config.deferDelivery) {
          terminalStderr.error(`[collect] Redis 采集失败，Evidence Bundle: ${failure.path}\n`);
        }
        return code;
      }
      terminalStderr.error(`[collect] 失败 Bundle 打包失败，原始证据保留在目录: ${staging}\n`);
      return 1;
    }
    let delivered = false;
    if (format === "bundle") {
      const packed = await packBundle(staging, outputPath);
      delivered = packed.ok;
      if (!packed.ok) terminalStderr.error(`[collect] 打包失败：${packed.stderr.trim() || `exit=${packed.exitCode}`}\n`);
    } else if (format === "html") {
      try {
        writeHtmlReport(staging, outputPath, {
          title: "doctor Redis 诊断报告",
          profileName: config.profileName,
          summaryHtml,
          sections: [
            ...(keyDistributionHtml ? [{ title: "Key 分布", html: keyDistributionHtml }] : []),
            ...(keyStatsHtml ? [{ title: "keyStats", html: keyStatsHtml }] : []),
            ...(prefixKeyPieCharts.length
              ? [{ title: "前缀 Key 占比", html: htmlPieCharts(prefixKeyPieCharts) }]
              : []),
            ...(prefixMemoryPieCharts.length
              ? [{ title: "前缀空间占比", html: htmlPieCharts(prefixMemoryPieCharts) }]
              : []),
            ...(ttlPieCharts.length ? [htmlPieChartSection("TTL 分布", ttlPieCharts)] : []),
          ],
        });
        delivered = true;
      } catch (err) {
        reportError(err, { context: "doctor store/redis/html-report", summary: "[collect] HTML 报告生成失败" });
      }
    } else {
      try {
        copyFileSync(join(staging, "summary.md"), resolve(outputPath));
        delivered = true;
      } catch (err) {
        reportError(err, { context: "doctor store/redis/markdown-report", summary: "[collect] Markdown 报告生成失败" });
      }
    }
    if (delivered) {
      rmSync(join(staging, ".."), { recursive: true, force: true });
      if (!config.deferDelivery) {
        terminalStdout.success(`[collect] ${REDIS_OUTPUT_LABELS[format]}: ${outputPath}\n`);
      }
    } else {
      const failure = await deliverFailureBundle({
        bundleDir: staging,
        bundleName,
        requestedOutput: config.output,
        collectCode: 1,
        reason: "成功产物生成失败",
      });
      if (failure.packed.ok) {
        rmSync(join(staging, ".."), { recursive: true, force: true });
        if (!config.deferDelivery) {
          terminalStderr.error(`[collect] 成功产物生成失败，Evidence Bundle: ${failure.path}\n`);
        }
      } else {
        terminalStderr.error(`[collect] 原始证据保留在目录: ${staging}\n`);
      }
    }
    return delivered ? code : 1;
  };

  collectContext.log(
    `[collect] 从 pod/${config.target.pod}`
    + `${config.target.container ? ` container/${config.target.container}` : ""} 确认 Redis 配置…`,
  );
  const confirmed = await confirmRedisTarget(executor, collectContext.execTarget, config);
  if (confirmed.target) {
    collectContext.redisTarget = confirmed.target;
    const sanitized = sanitizeRedisTarget(config, confirmed.targetFact);
    collectContext.log(`[collect] Redis endpoint: ${sanitized.endpoint}（${confirmed.target.endpointSource}）`);
    bundle.fill("resolve-target", {
      status: "ok",
      output: `${JSON.stringify(sanitized, null, 2)}\n`,
      ext: "json",
    });
    const prepared = await prepareRedisAccess(executor, config, confirmed.target, injectedAccess);
    collectContext.redisAccess = prepared.access;
    collectContext.closePreparation = prepared.close;
    bundle.fill("access-preparation", prepared.access
      ? {
          status: "ok",
          output: `${JSON.stringify({
            forwards: prepared.forwards.map((forward) => forward.command),
          }, null, 2)}\n`,
          ext: "json",
        }
      : { status: "unavailable", reason: prepared.reason ?? "Redis 采集准备失败" });
  } else {
    bundle.fill("resolve-target", {
      status: confirmed.targetFact.status === "unavailable" ? "unavailable" : "failed",
      reason: confirmed.reason ?? "Redis 目标未确认",
      command: confirmed.command,
    });
    bundle.fill("access-preparation", {
      status: "unavailable",
      reason: confirmed.reason ?? "Redis 目标未确认",
    });
  }

  const inspectRedis = makeRedisInspect(collectContext, config, confirmed);

  let facts: RedisInspectionFacts;
  try {
    collectContext.log("[collect] 采集 Facts…");
    facts = await runInspects([inspectRedis], undefined, collectContext.log);
    Object.assign(inspectionFacts, facts);
    collectContext.log("[collect] Facts 采集完成。");
  } catch (err) {
    writeErrorLog(err, "doctor store/redis/inspect");
    const reason = err instanceof Error ? err.message : String(err);
    // 目标都没解析出来，下游三格一律没戏。以前只写 summary.md，manifest 里它们直接消失。
    bundle.fill("resolve-target", { status: "failed", reason });
    bundle.settle(`解析 Redis 目标失败：${reason}`);
    bundle.writeSummary(`# Redis 诊断失败\n\n${reason}\n`);
    return finish({ namespace, pod, container, service: config.service, store: config.store?.id }, 1);
  }

  const sanitizedTarget = sanitizeRedisTarget(config, facts.target);

  if (collectContext.redisAccess && facts.capabilities.status === "collected") {
    if (mode === "sample") {
      try {
        collectContext.log("[collect] 正在发现 Redis database…");
        const discovered = await discoverRedisDatabases(collectContext);
        const scope = await selectRedisDatabaseScope(
          discovered.databases,
          discovered.clusterType,
          config.requestedDatabase,
        );
        if (!scope) return finish(sanitizedTarget, 130);
        collectContext.redisDatabaseScope = scope;
        const databases = scope.databases.map((database) => `db${database}`).join("、") || "无数据 DB";
        collectContext.log(`[collect] Redis database scope: ${scope.mode === "all" ? `所有有数据的 DB（${databases}）` : databases}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        bundle.settle(`Redis database 范围确认失败：${reason}`);
        bundle.writeSummary(`# Redis 诊断失败\n\n${reason}\n`);
        return finish(sanitizedTarget, 1);
      }
    } else {
      collectContext.redisDatabaseScope = config.requestedDatabase === undefined
        ? { mode: "all", databases: [] }
        : { mode: "single", databases: [config.requestedDatabase] };
    }
  }

  try {
    // redis 是"一个方面、一次受限外部访问、多条 observation"的标准形态：
    // 基础探针返回 overview + nodes + keyspaces；压力窗口单独建 Probe，10 秒 Probe
    // 通过显式依赖读取容量与 1 秒 Observation，再决定是否值得增加等待。
    const probeRedis = makeRedisRuntimeProbe();
    const probeRedisKeyStats = makeRedisKeyStatsProbe();
    const probeRedisPressure1s = makeRedisPressureProbe(1);
    const probeRedisPressure10s = makeRedisPressureProbe(10);
    const diagnosis: RedisDiagnosis = await runDiagnosis({
      ctx: collectContext,
      facts,
      config,
      log: collectContext.log,
      probes: [probeRedis, probeRedisPressure1s, probeRedisPressure10s, probeRedisKeyStats],
      buildEvidence: buildRedisEvidence,
      detectors: redisDetectors,
      buildCoverage: buildRedisCoverage,
    });
    bundle.fill("redis-findings", {
      status: "ok",
      output: `${JSON.stringify(diagnosis.findings, null, 2)}\n`,
      ext: "json",
    });
    bundle.writeSummary(buildRedisMarkdown(sanitizedTarget, diagnosis));
    summaryHtml = buildRedisHtml(sanitizedTarget, diagnosis);
    keyDistributionHtml = buildRedisKeyDistributionHtml(diagnosis);
    keyStatsHtml = buildRedisKeyStatsHtml(diagnosis);
    prefixKeyPieCharts = buildRedisPrefixKeyPieCharts(diagnosis);
    prefixMemoryPieCharts = buildRedisPrefixMemoryPieCharts(diagnosis);
    ttlPieCharts = buildRedisTtlPieCharts(diagnosis);
    const outcome = evaluateCollectOutcome([
      facts.capabilities.status === "collected",
      ...diagnosis.coverage.map((item) => item.status === "sufficient"),
    ]);
    if (outcome.evidence === "partial") {
      terminalStdout.warning("[collect] 部分完成：报告中已标明缺失证据。\n");
    } else if (outcome.evidence === "missing") {
      terminalStderr.error("[collect] 未形成可用诊断证据。\n");
    } else {
      terminalStdout.success("[collect] 完成。\n");
    }
    const disabledCatalogStore = !!config.store
      && !confirmed.target
      && confirmed.targetFact.status === "unavailable";
    return finish(
      { ...sanitizedTarget, service: config.service, store: config.store?.id },
      disabledCatalogStore ? 0 : outcome.exitCode,
    );
  } catch (err) {
    writeErrorLog(err, "doctor store/redis/runDiagnosis");
    const reason = err instanceof Error ? err.message : String(err);
    // 探针或判读挂了 → 剩下的格子（redis-probe 若还没填 / redis-findings）一并交代
    bundle.settle(reason);
    bundle.writeSummary(`# Redis 诊断失败\n\n${reason}\n`);
    return finish(sanitizedTarget, 1);
  }
}
