import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DOCTOR_CLI_VERSION } from "../../../app/version";
import { infra } from "../../../infra";
import type {
  CommandRunner,
  NetworkAnalysisInfra,
} from "../../../infra/host/network-analysis";
import { runArgv } from "../../../infra/k8s/executor";
import { findSelectableFiles, resolveFileSelection } from "../../../terminal/file-selection";
import { terminalStderr, terminalStdout } from "../../../terminal/output";
import { runCollect } from "../../engine";
import { writeHtmlReport } from "../../output/html";
import {
  buildNetworkCoverage,
  buildNetworkEvidence,
  networkArtifactObservations,
  networkDetectors,
  networkHopObservations,
} from "./detector";
import type {
  NetworkAnalysisConfig,
  NetworkAnalysisDocument,
  NetworkAnalysisFacts,
} from "./model";
import { networkPcapProbe } from "./probe";
import type { NetworkCaptureMode } from "../model";
import {
  buildNetworkAnalysisHtml,
  buildNetworkAnalysisInspector,
  renderNetworkAnalysisMarkdown,
} from "./render";

export type {
  NetworkAnalysisDocument,
  NetworkAnalysisFacts,
  NetworkFinding,
  NetworkHopObservation,
} from "./model";

export interface NetworkAnalyzeCliOpts {
  traceId?: string;
  captureId?: string;
  output?: string;
}

export interface NetworkAnalyzeDependencies {
  runner: CommandRunner;
  packetAnalysis: NetworkAnalysisInfra;
  log?: (line: string) => void;
}

interface ResolveNetworkAnalysisInputOptions {
  directory?: string;
  interactive?: boolean;
  prompt?: (files: readonly string[]) => Promise<string | undefined>;
}

const defaultDependencies: NetworkAnalyzeDependencies = {
  runner: runArgv,
  packetAnalysis: infra.host.networkAnalysis,
  log: (line) => terminalStdout.info(`[neta] ${line.replace(/^\[collect\]\s*/, "")}\n`),
};

const NETWORK_BUNDLE_NAME = /^doctor-net-\d{8}-\d{6}\.tar\.gz$/i;

export function findNetworkBundleFiles(directory: string): string[] {
  return findSelectableFiles(directory, (name) => NETWORK_BUNDLE_NAME.test(name));
}

export function resolveNetworkAnalysisInput(
  input: string | undefined,
  options: ResolveNetworkAnalysisInputOptions = {},
): Promise<string | undefined> {
  return resolveFileSelection({
    file: input,
    directory: options.directory,
    interactive: options.interactive,
    findCandidates: findNetworkBundleFiles,
    listTitle: "[neta] 当前目录可用的 NetBundle：",
    question: "请选择 NetBundle（序号或文件名，q 取消）：",
    invalidMessage: "输入无效，请选择列表中的序号或文件名。",
    cancelledMessage: "[neta] 已取消",
    missingFileMessage: "非交互环境请显式传 doctor neta <input>",
    noCandidatesMessage: "当前目录没有 doctor-net-YYYYMMDD-HHmmss.tar.gz；请显式传 doctor neta <input>",
    singleCandidateMessage: (file) => `[neta] NetBundle：${file}（当前目录唯一候选，自动选择）`,
    prompt: options.prompt,
  });
}

interface PreparedBundle {
  root: string;
  cleanup(): void;
}

interface NetManifest {
  started_at?: string;
  finished_at?: string;
  target?: {
    namespace?: string;
    services?: string[];
    capture_id?: string;
    trace_ids?: string[];
  };
  params?: {
    capture_mode?: NetworkCaptureMode;
  };
  inspection_facts?: {
    topology?: {
      services?: Array<{
        name?: string;
        clusterIp?: string;
        ports?: number[];
        pods?: string[];
      }>;
      targets?: Array<{
        pod?: string;
        podIp?: string;
        services?: string[];
      }>;
    };
    capture_artifacts?: Array<{
      pod?: string;
      services?: string[];
      file?: string;
      sha256?: string;
      verified?: boolean;
      window_complete?: boolean;
      reason?: string;
    }>;
    response?: {
      status_code?: number;
      content_type?: string;
      body_bytes?: number;
      response_ended_at?: string;
      termination_reason?: string;
    };
  };
}

function outputPaths(
  input: string,
  configured?: string,
): { markdown: string; html: string; json: string } {
  const defaultBase = join(".", `${basename(input).replace(/\.(?:tar\.gz|tgz)$/i, "")}-analysis`);
  const base = configured?.trim()
    ? resolve(configured).replace(/\.(?:md|html|json)$/i, "")
    : defaultBase;
  return {
    markdown: `${base}.md`,
    html: `${base}.html`,
    json: `${base}.json`,
  };
}

function safeArchiveEntries(raw: string): boolean {
  return raw.split(/\r?\n/).filter(Boolean).every((entry) => {
    if (entry.startsWith("/") || entry.includes("\\")) return false;
    return !entry.split("/").some((part) => part === "..");
  });
}

function locateBundleRoot(directory: string): string {
  if (existsSync(join(directory, "manifest.json"))) return directory;
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((item) => item.isDirectory() && existsSync(join(directory, item.name, "manifest.json")))
    .map((item) => join(directory, item.name));
  if (candidates.length !== 1) {
    throw new Error(`NetBundle 必须包含唯一 manifest.json，实际候选 ${candidates.length} 个`);
  }
  return candidates[0]!;
}

async function prepareBundle(input: string, runner: CommandRunner): Promise<PreparedBundle> {
  const absolute = resolve(input);
  if (!existsSync(absolute)) throw new Error(`NetBundle 不存在: ${input}`);
  if (statSync(absolute).isDirectory()) return { root: locateBundleRoot(absolute), cleanup: () => undefined };
  const listed = await runner(["tar", "-tzf", absolute], { timeoutMs: 60_000 });
  if (!listed.ok) throw new Error(`读取 NetBundle 目录失败：${listed.stderr.trim() || `exit=${listed.exitCode}`}`);
  if (!safeArchiveEntries(listed.stdout)) throw new Error("NetBundle 包含不安全的归档路径");
  const temporary = mkdtempSync(join(tmpdir(), "doctor-neta-"));
  const extracted = await runner(["tar", "-xzf", absolute, "-C", temporary], { timeoutMs: 60_000 });
  if (!extracted.ok) {
    rmSync(temporary, { recursive: true, force: true });
    throw new Error(`解压 NetBundle 失败：${extracted.stderr.trim() || `exit=${extracted.exitCode}`}`);
  }
  return {
    root: locateBundleRoot(temporary),
    cleanup: () => rmSync(temporary, { recursive: true, force: true }),
  };
}

function buildNetworkAnalysisFacts(
  input: string,
  manifest: NetManifest,
  opts: NetworkAnalyzeCliOpts,
  config: NetworkAnalysisConfig,
): NetworkAnalysisFacts {
  const requestedCaptureId = opts.captureId?.trim();
  const captureId = requestedCaptureId || manifest.target?.capture_id;
  const traceIds = (opts.traceId?.split(",") ?? manifest.target?.trace_ids ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  const identifiers = [
    ...new Set([
      requestedCaptureId ?? (config.mode === "tracking" ? captureId : undefined),
      ...traceIds,
    ].filter((id): id is string => !!id)),
  ];
  if (config.mode === "tracking" && !identifiers.length) {
    throw new Error("跟踪模式 NetBundle 和命令参数都没有 capture ID / trace ID");
  }
  const artifacts = (manifest.inspection_facts?.capture_artifacts ?? [])
    .filter((item): item is typeof item & { pod: string; file: string } => !!item.pod && !!item.file)
    .map((item) => ({
      pod: item.pod,
      services: item.services ?? [],
      file: item.file,
      sha256: item.sha256,
      windowComplete: item.window_complete === true,
      reason: item.reason,
    }));
  if (!artifacts.length) throw new Error("NetBundle 没有可分析的 PCAP artifact");
  const topology = manifest.inspection_facts?.topology;
  return {
    sourceBundle: basename(input),
    namespace: manifest.target?.namespace,
    requestedServices: manifest.target?.services ?? [],
    captureId,
    traceIds,
    identifiers,
    startedAt: manifest.started_at,
    finishedAt: manifest.finished_at,
    services: (topology?.services ?? [])
      .filter((item): item is typeof item & { name: string } => !!item.name)
      .map((item) => ({
        name: item.name,
        clusterIp: item.clusterIp,
        ports: item.ports ?? [],
        pods: item.pods ?? [],
      })),
    pods: (topology?.targets ?? [])
      .filter((item): item is typeof item & { pod: string } => !!item.pod)
      .map((item) => ({
        pod: item.pod,
        podIp: item.podIp,
        services: item.services ?? [],
      })),
    artifacts,
    triggerResponse: manifest.inspection_facts?.response
      ? {
          statusCode: manifest.inspection_facts.response.status_code,
          contentType: manifest.inspection_facts.response.content_type,
          bodyBytes: manifest.inspection_facts.response.body_bytes,
          endedAt: manifest.inspection_facts.response.response_ended_at,
          terminationReason: manifest.inspection_facts.response.termination_reason,
        }
      : undefined,
  };
}

function buildNetworkAnalysisConfig(manifest: NetManifest): NetworkAnalysisConfig {
  const mode = manifest.params?.capture_mode;
  if (!mode) {
    throw new Error("NetBundle 缺少必需的 params.capture_mode");
  }
  return {
    mode,
    timeoutMs: 10 * 60_000,
  };
}

function writeNetworkAnalysisHtml(
  document: NetworkAnalysisDocument,
  outputPath: string,
): void {
  const staging = mkdtempSync(join(tmpdir(), "doctor-network-analysis-report-"));
  const facts = document.diagnosis.evidence.facts;
  try {
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify({
      doctor_version: DOCTOR_CLI_VERSION,
      target: {
        namespace: facts.namespace,
        services: facts.requestedServices.join(","),
        capture_id: facts.captureId,
      },
      inspection_facts: facts,
      params: {
        command: "neta",
        source_bundle: facts.sourceBundle,
        analyzer_schema: document.schema,
        capture_mode: document.config.mode,
      },
      started_at: facts.startedAt,
      finished_at: facts.finishedAt,
      steps: [],
    }, null, 2)}\n`, "utf-8");
    writeHtmlReport(staging, outputPath, {
      title: "Doctor 网络调用诊断",
      profileName: "offline",
      summaryHtml: buildNetworkAnalysisHtml(document),
      overlay: {
        title: "HTTP Exchange",
        ariaLabel: "HTTP 请求详情",
        html: buildNetworkAnalysisInspector(document),
      },
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function analyzeNetworkBundle(
  input: string,
  opts: NetworkAnalyzeCliOpts,
  dependencies: NetworkAnalyzeDependencies = defaultDependencies,
): Promise<{ analysis: NetworkAnalysisDocument; markdown: string }> {
  const prepared = await prepareBundle(input, dependencies.runner);
  try {
    const manifest = JSON.parse(readFileSync(join(prepared.root, "manifest.json"), "utf-8")) as NetManifest;
    const config = buildNetworkAnalysisConfig(manifest);
    const execution = await runCollect({
      ctx: {
        bundleRoot: prepared.root,
        packetAnalysis: dependencies.packetAnalysis,
      },
      config,
      inspects: [{
        id: "network-bundle",
        run: async () => buildNetworkAnalysisFacts(input, manifest, opts, config),
      }],
      planProbes: () => [networkPcapProbe],
      log: dependencies.log ?? (() => undefined),
      buildEvidence: buildNetworkEvidence,
      detectors: networkDetectors,
      buildCoverage: (evidence) => buildNetworkCoverage(evidence, config),
    });
    const { facts, diagnosis } = execution;
    const artifacts = networkArtifactObservations(diagnosis.evidence);
    const hops = networkHopObservations(diagnosis.evidence);
    const streams = new Set(hops.map((hop) => hop.stream));
    const analysis: NetworkAnalysisDocument = {
      schema: "doctor.net.analysis/v4",
      config,
      analyzer: {
        decoder: artifacts.find((artifact) => artifact.decoder)?.decoder,
      },
      summary: {
        pcapCount: facts.artifacts.length,
        verifiedPcapCount: artifacts.filter((artifact) => artifact.verified).length,
        decodedPcapCount: artifacts.filter((artifact) => artifact.decoded).length,
        matchedStreamCount: streams.size,
        hopCount: hops.length,
      },
      diagnosis,
    };
    return { analysis, markdown: renderNetworkAnalysisMarkdown(analysis) };
  } finally {
    prepared.cleanup();
  }
}

export async function runAnalyzeNetwork(
  input: string | undefined,
  opts: NetworkAnalyzeCliOpts,
  dependencies: NetworkAnalyzeDependencies = defaultDependencies,
): Promise<number> {
  try {
    const selectedInput = await resolveNetworkAnalysisInput(input);
    if (!selectedInput) return 130;
    const result = await analyzeNetworkBundle(selectedInput, opts, dependencies);
    const paths = outputPaths(selectedInput, opts.output);
    writeFileSync(paths.markdown, result.markdown, { mode: 0o600 });
    writeFileSync(paths.json, `${JSON.stringify(result.analysis, null, 2)}\n`, { mode: 0o600 });
    writeNetworkAnalysisHtml(result.analysis, paths.html);
    chmodSync(paths.markdown, 0o600);
    chmodSync(paths.html, 0o600);
    chmodSync(paths.json, 0o600);
    terminalStdout.success(
      `[neta] Markdown: ${paths.markdown}\n`
      + `[neta] HTML: ${paths.html}\n`
      + `[neta] JSON: ${paths.json}\n`,
    );
    return result.analysis.summary.decodedPcapCount > 0 ? 0 : 1;
  } catch (error) {
    terminalStderr.error(`[neta] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
