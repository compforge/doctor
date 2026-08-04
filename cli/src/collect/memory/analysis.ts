import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { infra } from "../../infra";
import {
  runLocalCommand,
  type LocalContainerEngine,
} from "../../infra/host/container-engine";
import { spawnProcess } from "../../infra/host/process";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import {
  htmlHeading,
  htmlPieChartSection,
  htmlParagraph,
  htmlTable,
  htmlTableCell,
  writeHtmlReport,
} from "../output/html";
import {
  MEMORY_CAPTURE_SCHEMA,
  readMemoryCaptureArtifact,
  resolveCaptureHeapPath,
} from "./capture-artifact";
import { diagnosePyHeapAnalysis } from "./detector/pyheap";
import { resolveEmbeddedPyHeapTool } from "./embedded-pyheap";
import {
  findLocalDoctorDebugImages,
  localContainerPyHeapAnalyzerArgv,
  supportsPyHeapAnalyzer,
} from "./local-container-analyzer";
import {
  PYHEAP_ANALYSIS_SCHEMA,
  readPyHeapAnalysis,
  type PyHeapAnalysis,
} from "./pyheap-analysis";
import { buildPyHeapAnalysisHtml, buildPyHeapPieCharts } from "./pyheap-render";
import { localPyheapRetainedArgv, PYHEAP_VERSION } from "./pyheap-tool";

export interface MemoryAnalysisOptions {
  inputs?: string[];
  output?: string;
  profileName?: string;
}

interface ResolvedAnalysis {
  inputPath: string;
  heapPath?: string;
  analysisPath: string;
  analysis: PyHeapAnalysis;
  reused: boolean;
}

const ANALYSIS_TIMEOUT_MS = 30 * 60_000;
const CAPTURE_INDEX_NAME = /^doctor-mem-.+-pid\d+-\d{8}-\d{6}\.json$/i;

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function artifactSchema(path: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(path, "utf-8")) as { schema?: string }).schema;
  } catch {
    return undefined;
  }
}

function analysisPathForHeap(heapPath: string): string {
  return heapPath.replace(/\.pyheap$/i, ".pyheap-analysis.json");
}

export function findMemoryAnalysisInputs(directory: string): string[] {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const captures = files
    .filter((name) => CAPTURE_INDEX_NAME.test(name))
    .map((name) => join(directory, name))
    .filter((path) => artifactSchema(path) === MEMORY_CAPTURE_SCHEMA);
  if (captures.length) return captures;
  const analyses = files.filter((name) => /\.pyheap-analysis\.json$/i.test(name));
  if (analyses.length) return analyses.map((name) => join(directory, name));
  return files.filter((name) => /\.pyheap$/i.test(name)).map((name) => join(directory, name));
}

type PyHeapAnalyzerBackend =
  | { kind: "native"; analyzer: string }
  | { kind: "container"; engine: LocalContainerEngine; image: string };

function localFailure(result: {
  stderr: string;
  stdout: string;
  errorCode?: string;
  exitCode?: number;
  timedOut: boolean;
}): string {
  if (result.timedOut) return "启动超时";
  return result.stderr.trim()
    || result.stdout.trim()
    || result.errorCode
    || `exit=${result.exitCode ?? "unknown"}`;
}

async function resolvePyHeapAnalyzerBackend(): Promise<PyHeapAnalyzerBackend> {
  const analyzer = resolveEmbeddedPyHeapTool("analyzer");
  const probeRoot = mkdtempSync(join(tmpdir(), "doctor-mema-probe-"));
  let nativeReason = "未知错误";
  try {
    const native = await runLocalCommand(
      ["python3", analyzer, "retained-heap", "--help"],
      {
        env: {
          ...process.env,
          PEX_ROOT: join(probeRoot, "pex"),
          PYHEAP_CACHE_DIR: join(probeRoot, "cache"),
        },
        timeoutMs: 60_000,
      },
    );
    if (native.ok) return { kind: "native", analyzer };
    nativeReason = localFailure(native);
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }

  terminalStdout.write(
    `[collect] 本机 Python 无法直接运行 PyHeap analyzer（${nativeReason}），尝试本地 doctor-debug image…\n`,
  );
  const engine = await infra.host.containerEngine();
  if (!engine) {
    throw new Error(
      `本机 PyHeap analyzer 不可用（${nativeReason}），且没有可用的 Docker、Podman 或 nerdctl；`
      + "请先安装兼容 Python，或执行 doctor image --tar <doctor-debug.tar> 准备本地 image",
    );
  }
  const images = await findLocalDoctorDebugImages(engine);
  for (const image of images) {
    if (await supportsPyHeapAnalyzer(engine, image)) {
      terminalStdout.write(`[collect] 使用本地 ${engine.name} image 分析：${image}\n`);
      return { kind: "container", engine, image };
    }
  }
  throw new Error(
    `本机 PyHeap analyzer 不可用（${nativeReason}），${engine.name} 中也没有携带兼容 analyzer 的 `
    + "doctor-debug image；请先执行 doctor image --tar <doctor-debug.tar>",
  );
}

class PyHeapAnalyzerRunner {
  private backend?: Promise<PyHeapAnalyzerBackend>;

  private resolveBackend(): Promise<PyHeapAnalyzerBackend> {
    this.backend ??= resolvePyHeapAnalyzerBackend();
    return this.backend;
  }

  async run(heapPath: string, analysisPath: string): Promise<void> {
    const backend = await this.resolveBackend();
    await runAnalyzer(backend, heapPath, analysisPath);
  }
}

async function runAnalyzer(
  backend: PyHeapAnalyzerBackend,
  heapPath: string,
  analysisPath: string,
): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "doctor-mema-"));
  const pexRoot = join(workDir, "pex");
  const cacheDirectory = join(workDir, "cache");
  mkdirSync(pexRoot, { recursive: true, mode: 0o700 });
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const outputPart = `${analysisPath}.part-${process.pid}-${Date.now()}`;
  const argv = backend.kind === "native"
    ? localPyheapRetainedArgv(backend.analyzer, heapPath)
    : localContainerPyHeapAnalyzerArgv(backend.engine, backend.image, heapPath);
  const child = spawnProcess(argv, {
    env: backend.kind === "native" ? {
      ...process.env,
      PEX_ROOT: pexRoot,
      PYHEAP_CACHE_DIR: cacheDirectory,
    } : process.env,
  });
  const stderrPromise = new Response(child.stderr).text();
  const stdoutPromise = pipeline(
    Readable.fromWeb(child.stdout),
    createWriteStream(outputPart, { mode: 0o600 }),
  );
  const timeout = setTimeout(() => child.kill(), ANALYSIS_TIMEOUT_MS);
  try {
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      stderrPromise,
      stdoutPromise,
    ]).then(([code, error]) => [code, error] as const);
    if (exitCode !== 0) {
      throw new Error(`PyHeap analyzer 失败（exit=${exitCode}）：${stderr.trim() || "无错误输出"}`);
    }
    renameSync(outputPart, analysisPath);
  } finally {
    clearTimeout(timeout);
    rmSync(outputPart, { force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function resolveHeapAnalysis(
  inputPath: string,
  analyzer: PyHeapAnalyzerRunner,
): Promise<ResolvedAnalysis> {
  if (!existsSync(inputPath)) throw new Error(`输入文件不存在: '${inputPath}'`);
  if (!/\.pyheap$/i.test(inputPath)) throw new Error(`不是 .pyheap 文件: '${inputPath}'`);
  const heapBytes = statSync(inputPath).size;
  const heapSha256 = await sha256File(inputPath);
  const analysisPath = analysisPathForHeap(inputPath);
  if (existsSync(analysisPath)) {
    try {
      const cached = readPyHeapAnalysis(analysisPath);
      if (cached.source.size_bytes === heapBytes && cached.source.sha256 === heapSha256) {
        return { inputPath, heapPath: inputPath, analysisPath, analysis: cached, reused: true };
      }
      terminalStdout.write(`[collect] 已有 JSON 与 heap 不匹配，将重新解析：${analysisPath}\n`);
    } catch {
      terminalStdout.write(`[collect] 已有 JSON 无效，将重新解析：${analysisPath}\n`);
    }
  }

  terminalStdout.write(
    `[collect] 正在解析 ${basename(inputPath)}；retained-heap 可能占用较多本机内存…\n`,
  );
  await analyzer.run(inputPath, analysisPath);
  const analysis = readPyHeapAnalysis(analysisPath);
  if (analysis.source.size_bytes !== heapBytes || analysis.source.sha256 !== heapSha256) {
    throw new Error(`analyzer 输出的 source 与 heap 不一致: '${analysisPath}'`);
  }
  return { inputPath, heapPath: inputPath, analysisPath, analysis, reused: false };
}

async function resolveAnalysisInput(
  input: string,
  analyzer: PyHeapAnalyzerRunner,
): Promise<ResolvedAnalysis> {
  const inputPath = resolve(input);
  if (/\.pyheap$/i.test(inputPath)) return resolveHeapAnalysis(inputPath, analyzer);
  if (!existsSync(inputPath)) throw new Error(`输入文件不存在: '${inputPath}'`);

  const schema = artifactSchema(inputPath);
  if (schema === MEMORY_CAPTURE_SCHEMA) {
    const capture = readMemoryCaptureArtifact(inputPath);
    const heapPath = resolveCaptureHeapPath(inputPath, capture);
    const resolved = await resolveHeapAnalysis(heapPath, analyzer);
    return { ...resolved, inputPath };
  }
  if (schema === PYHEAP_ANALYSIS_SCHEMA) {
    return {
      inputPath,
      analysisPath: inputPath,
      analysis: readPyHeapAnalysis(inputPath),
      reused: true,
    };
  }
  throw new Error(
    `不支持的内存分析输入: '${inputPath}'；需要 .pyheap、${MEMORY_CAPTURE_SCHEMA} 或 ${PYHEAP_ANALYSIS_SCHEMA}`,
  );
}

function formatBytes(bytes: number): string {
  if (Math.abs(bytes) >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (Math.abs(bytes) >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (Math.abs(bytes) >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function aggregateTypes(analysis: PyHeapAnalysis): Map<string, { count: number; bytes: number }> {
  const result = new Map<string, { count: number; bytes: number }>();
  for (const item of analysis.types) {
    const previous = result.get(item.type_name) ?? { count: 0, bytes: 0 };
    result.set(item.type_name, {
      count: previous.count + item.object_count,
      bytes: previous.bytes + item.shallow_size_bytes,
    });
  }
  return result;
}

function buildComparisonHtml(items: readonly ResolvedAnalysis[]): string {
  if (items.length < 2) return "";
  const first = items[0]!;
  const last = items.at(-1)!;
  const firstTypes = aggregateTypes(first.analysis);
  const lastTypes = aggregateTypes(last.analysis);
  const names = new Set([...firstTypes.keys(), ...lastTypes.keys()]);
  const deltas = [...names].map((name) => {
    const before = firstTypes.get(name) ?? { count: 0, bytes: 0 };
    const after = lastTypes.get(name) ?? { count: 0, bytes: 0 };
    return {
      name,
      before,
      after,
      countDelta: after.count - before.count,
      bytesDelta: after.bytes - before.bytes,
    };
  }).sort((left, right) => Math.abs(right.bytesDelta) - Math.abs(left.bytesDelta));

  return [
    htmlHeading(1, "多次对象堆对比"),
    htmlParagraph(
      `按 dump 时间从 ${first.analysis.source.created_at} 对比到 ${last.analysis.source.created_at}。`
      + "这里只比较 type 级对象数和 shallow size；对象地址跨进程/时点不稳定，不把 retained owner 地址直接做差。",
    ),
    htmlTable(
      ["类型", "首次对象数", "末次对象数", "对象数变化", "首次 shallow", "末次 shallow", "shallow 变化"],
      deltas.slice(0, 100).map((item) => [
        item.name,
        htmlTableCell(item.before.count.toLocaleString("en-US"), item.before.count),
        htmlTableCell(item.after.count.toLocaleString("en-US"), item.after.count),
        htmlTableCell(`${item.countDelta >= 0 ? "+" : ""}${item.countDelta.toLocaleString("en-US")}`, item.countDelta),
        htmlTableCell(formatBytes(item.before.bytes), item.before.bytes),
        htmlTableCell(formatBytes(item.after.bytes), item.after.bytes),
        htmlTableCell(`${item.bytesDelta >= 0 ? "+" : ""}${formatBytes(item.bytesDelta)}`, item.bytesDelta),
      ]),
    ),
  ].join("");
}

function timestamp(date: Date): string {
  return date.toISOString().replaceAll(/[:-]/g, "").replace("T", "-").slice(0, 15);
}

function defaultReportPath(items: readonly ResolvedAnalysis[], now: Date): string {
  if (items.length === 1) {
    return items[0]!.analysisPath.replace(/\.pyheap-analysis\.json$/i, ".html");
  }
  return resolve(`doctor-mema-${timestamp(now)}.html`);
}

function reportPath(requested: string | undefined, fallback: string): string {
  if (!requested?.trim()) return resolve(fallback);
  return resolve(/\.html$/i.test(requested) ? requested : `${requested}.html`);
}

function writeAnalysisReport(
  items: readonly ResolvedAnalysis[],
  outputPath: string,
  profileName: string,
): void {
  const staging = mkdtempSync(join(tmpdir(), "doctor-mema-report-"));
  try {
    const now = new Date().toISOString();
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify({
      doctor_version: DOCTOR_CLI_VERSION,
      target: { kind: "python-heap-analysis", source_count: items.length },
      inspection_facts: {},
      params: {
        command: "mema",
        pyheap_version: PYHEAP_VERSION,
        inputs: items.map((item) => basename(item.inputPath)),
        analyses: items.map((item) => basename(item.analysisPath)),
      },
      started_at: now,
      finished_at: now,
      steps: [],
    }, null, 2)}\n`, "utf-8");
    const details = items.map((item, index) => [
      htmlHeading(1, items.length === 1
        ? "对象堆分析"
        : `对象堆 ${index + 1}：${basename(item.inputPath)}`),
      buildPyHeapAnalysisHtml(item.analysis, diagnosePyHeapAnalysis(item.analysis)),
    ].join("")).join("");
    writeHtmlReport(staging, outputPath, {
      title: items.length === 1 ? "doctor Python 对象堆诊断报告" : "doctor Python 对象堆对比报告",
      profileName,
      summaryHtml: `${buildComparisonHtml(items)}${details}`,
      sections: [htmlPieChartSection(
        "最近一次对象堆构成",
        buildPyHeapPieCharts(items.at(-1)!.analysis),
      )],
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** 纯本地分析入口：只读取本机 artifact，不连接 Kubernetes，也不在 Pod 内运行 analyzer。 */
export async function runMemoryAnalysis(opts: MemoryAnalysisOptions): Promise<number> {
  try {
    const inputs = opts.inputs?.filter((input) => input.trim()) ?? [];
    const candidates = inputs.length ? inputs : findMemoryAnalysisInputs(resolve(process.cwd()));
    if (!candidates.length) {
      throw new Error("当前目录没有 .pyheap、capture JSON 或 PyHeap analysis JSON");
    }
    const resolved: ResolvedAnalysis[] = [];
    const seen = new Set<string>();
    const analyzer = new PyHeapAnalyzerRunner();
    for (const input of candidates) {
      const item = await resolveAnalysisInput(input, analyzer);
      if (seen.has(item.analysis.source.sha256)) continue;
      seen.add(item.analysis.source.sha256);
      resolved.push(item);
      terminalStdout.write(
        `[collect] ${item.reused ? "复用" : "生成"}分析 JSON：${item.analysisPath}\n`,
      );
    }
    resolved.sort((left, right) =>
      left.analysis.source.created_at.localeCompare(right.analysis.source.created_at));
    const outputPath = reportPath(opts.output, defaultReportPath(resolved, new Date()));
    writeAnalysisReport(resolved, outputPath, opts.profileName ?? "default");
    terminalStdout.success(`[collect] Memory 分析报告：${outputPath}\n`);
    if (resolved.length > 1) {
      terminalStdout.write(`[collect] 已对比 ${resolved.length} 份 heap 的 type 对象数与 shallow size 变化\n`);
    }
    return 0;
  } catch (error) {
    terminalStderr.error(`[collect] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
