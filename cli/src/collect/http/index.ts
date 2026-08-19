import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import {
  inspectLocalHttpEndpoint,
  sendHttpRequest,
  type InspectHttpEndpoint,
} from "../../infra/http";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import type { CommandContext } from "../../command";
import type { KubernetesCommandInput } from "../../command/kubernetes-target";
import { runDiagnosis } from "../engine";
import { EvidenceBundle, type OutcomeDecl } from "../evidence";
import { runInspects } from "../inspect-engine";
import { evaluateCollectOutcome } from "../outcome";
import { resolveArchivePath, resolveDefaultReportPaths } from "../output/archive";
import { recordFailureBundle } from "../output/failure-bundle";
import { writeHtmlReport } from "../output/html";
import type { SendHttp } from "../shared/http/capture";
import { HTTP_DEFAULTS, loadHttpScenario } from "../shared/http/config";
import {
  buildHttpCoverage,
  buildHttpDiagnosis,
  buildHttpEvidence,
  detectHttpAttempt,
  diagnoseHttp,
  httpDetectors,
} from "./detector";
import { resolvePodHttpExecution } from "./execution";
import {
  resolveHttpExecutionLocation,
} from "./execution-location";
import { makeHttpEndpointInspect } from "./fact/inspect";
import type {
  HttpDiagnosis,
  HttpExecutionTarget,
  HttpFinding,
  HttpInspectionFacts,
  HttpScenario,
} from "../shared/http/model";
import {
  httpAttemptId,
  makeHttpRequestProbe,
  serializeHttpAttempt,
} from "./probe/request";
import type { HttpCommandContext } from "./context";
import { buildHttpHtml, buildHttpMarkdown } from "./render";
import { resolveHttpScenarioFile, resolveHttpScenarioRequests, writeHttpScenarioExample } from "./scenario-file";

export { HTTP_DEFAULTS, loadHttpScenario } from "../shared/http/config";
export { captureHttpResponse } from "../shared/http/capture";
export { detectHttpAttempt, diagnoseHttp } from "./detector";
export { buildHttpHtml, buildHttpMarkdown, renderHttpRequestAsCurl } from "./render";
export {
  HTTP_EXECUTION_LOCATION_CHOICES,
  matchHttpExecutionLocation,
  parseHttpExecutionLocation,
  resolveHttpExecutionLocation,
} from "./execution-location";
export {
  findHttpScenarioFiles,
  filterHttpScenarioRequests,
  HTTP_SCENARIO_EXAMPLE,
  resolveHttpScenarioFile,
  resolveHttpScenarioRequests,
  writeHttpScenarioExample,
} from "./scenario-file";
export type { HttpDiagnosis, HttpExecution, HttpExecutionTarget, HttpFinding, HttpScenario } from "../shared/http/model";

export type HttpOutputFormat = "default" | "bundle" | "html" | "md";

export interface CollectHttpCliOpts extends KubernetesCommandInput {
  location?: string;
  pod?: string;
  container?: string;
  file?: string;
  example?: string | boolean;
  request?: string;
  repeat: string;
  interval: string;
  timeout?: string;
  inspectTimeout?: string;
  maxSize?: string;
  format?: string;
  output?: string;
}

function executionTargetLabel(target: HttpExecutionTarget): string {
  return target.kind === "local"
    ? "local"
    : `pod namespace=${target.namespace} pod=${target.pod} container=${target.container}`;
}

function positiveNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} 需要正数: '${value}'`);
  return parsed;
}

function nonNegativeNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} 需要 >= 0: '${value}'`);
  return parsed;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} 需要 >= 1 的整数: '${value}'`);
  return parsed;
}

export function defaultHttpBundleName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `doctor-http-${timestamp}`;
}

export function parseHttpOutputFormat(value: string | undefined): HttpOutputFormat {
  const format = value?.trim() || "default";
  if (format !== "default" && format !== "bundle" && format !== "html" && format !== "md") {
    throw new Error(`--format 只支持 bundle、html 或 md: '${format}'`);
  }
  return format;
}

export function resolveHttpOutputPath(output: string | undefined, name: string, format: HttpOutputFormat): string {
  if (format === "default") return resolveDefaultReportPaths(output, name).html;
  if (format === "bundle") {
    if (/\.(?:html|md)$/i.test(output ?? "")) {
      throw new Error("--format bundle 的输出路径不能使用 .html/.md 后缀");
    }
    return resolveArchivePath(output, name);
  }
  if (format === "html") {
    if (!output) return join(".", `${name}.html`);
    if (/\.(?:tar\.gz|tgz|md)$/i.test(output)) {
      throw new Error("--format html 的输出路径不能使用 .tar.gz/.tgz/.md 后缀");
    }
    return output.toLowerCase().endsWith(".html") ? output : `${output}.html`;
  }
  if (!output) return join(".", `${name}.md`);
  if (/\.(?:tar\.gz|tgz|html)$/i.test(output)) {
    throw new Error("--format md 的输出路径不能使用 .tar.gz/.tgz/.html 后缀");
  }
  return output.toLowerCase().endsWith(".md") ? output : `${output}.md`;
}

function sanitizedScenario(scenario: HttpScenario): Record<string, unknown> {
  return {
    schema: scenario.schema,
    name: scenario.name,
    requests: scenario.requests.map((group) => ({
      id: group.id,
      compare: { body: group.compare.body, sse_events: group.compare.sseEvents },
      entrypoints: group.entrypoints.map((request) => ({
        id: request.entrypointId,
        method: request.method,
        url: request.url,
        header_names: Object.keys(request.headers),
        has_body: request.body !== undefined,
        follow_redirects: request.followRedirects,
        timeout_ms: request.timeoutMs,
        max_response_bytes: request.maxResponseBytes,
        expect: {
          status: request.expect.status,
          content_type: request.expect.contentType,
          max_duration_ms: request.expect.maxDurationMs,
          sse_terminal_event: request.expect.sseTerminalEvent,
        },
      })),
    })),
  };
}

function serializeFinding(finding: HttpFinding): Record<string, unknown> {
  return { ...finding };
}

function writeHttpArtifact(
  staging: string,
  profileName: string,
  summaryHtml: string,
): boolean {
  try {
    writeHtmlReport(staging, join(staging, "report.html"), {
      title: "doctor http 诊断报告",
      profileName,
      summaryHtml,
    });
    return true;
  } catch (error) {
    terminalStderr.error(`[http] 产物生成失败：${error instanceof Error ? error.message : String(error)}\n`);
    return false;
  }
}

export async function runCollectHttp(
  opts: CollectHttpCliOpts,
  commandContext: CommandContext,
  sendHttp?: SendHttp,
  inspectEndpoint?: InspectHttpEndpoint,
): Promise<number> {
  if (opts.example !== undefined) {
    if (opts.file) {
      terminalStderr.error("--example 与 --file 不能同时使用\n");
      return 2;
    }
    try {
      const output = writeHttpScenarioExample(typeof opts.example === "string" ? opts.example : undefined);
      terminalStderr.success(`[http] 示例已生成：${output}\n`);
      return 0;
    } catch (error) {
      terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }

  let executionTarget: HttpExecutionTarget;
  let activeSendHttp = sendHttp;
  let activeInspectEndpoint = inspectEndpoint;
  let reportProfileName = commandContext.profile.name;
  try {
    const location = await resolveHttpExecutionLocation({
      location: opts.location,
      pod: opts.pod,
      container: opts.container,
    });
    if (!location) return 130;
    if (location === "local") {
      executionTarget = { kind: "local" };
      activeSendHttp ??= sendHttpRequest;
      activeInspectEndpoint ??= inspectLocalHttpEndpoint;
      terminalStdout.write("[http] 请求执行位置：local（Doctor 本机）\n");
    } else {
      const execution = await resolvePodHttpExecution(opts, commandContext);
      if (!execution) return 130;
      executionTarget = execution.target;
      activeSendHttp ??= execution.sendHttp;
      activeInspectEndpoint ??= execution.inspectEndpoint;
      reportProfileName = execution.collect.profileName;
    }
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let repeat: number;
  let intervalSeconds: number;
  let timeoutSeconds: number | undefined;
  let inspectTimeoutSeconds: number;
  let maxResponseMiB: number | undefined;
  let format: HttpOutputFormat;
  try {
    repeat = positiveInteger(opts.repeat, "--repeat");
    intervalSeconds = nonNegativeNumber(opts.interval, "--interval");
    timeoutSeconds = positiveNumber(opts.timeout, "--timeout");
    inspectTimeoutSeconds = positiveNumber(opts.inspectTimeout ?? "3", "--inspect-timeout")!;
    maxResponseMiB = positiveNumber(opts.maxSize, "--max-size");
    format = parseHttpOutputFormat(opts.format);
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let scenarioFile: string;
  let scenario: HttpScenario;
  try {
    const file = await resolveHttpScenarioFile({ file: opts.file });
    if (!file) return 0;
    scenarioFile = file;
    const loaded = loadHttpScenario(scenarioFile, { timeoutSeconds, maxResponseMiB });
    const selected = await resolveHttpScenarioRequests(loaded, { request: opts.request });
    if (!selected) return 0;
    scenario = selected;
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const bundleName = defaultHttpBundleName(new Date());
  try {
    resolveHttpOutputPath(opts.output, bundleName, format);
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-http-"));
  const staging = join(stagingRoot, bundleName);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  commandContext.artifacts.add("http", staging);
  const startedAt = new Date();
  const entrypointCount = scenario.requests.reduce((count, group) => count + group.entrypoints.length, 0);
  terminalStderr.info(`[http] 场景 ${scenario.name}：${scenario.requests.length} 个逻辑请求、${entrypointCount} 个入口 × ${repeat} 轮\n`);
  const attempts = Array.from({ length: repeat }, (_, index) => index + 1).flatMap(
    (round) => scenario.requests.flatMap((group) => group.entrypoints.map((request) => ({ request, round }))),
  );
  const outcomes: OutcomeDecl[] = [
    { id: "http-endpoint-connectivity", title: "HTTP endpoint DNS/TCP 连通性", risk: "observe" },
    ...attempts.map(({ request, round }) => ({
      id: httpAttemptId(request, round),
      title: `${request.requestId}/${request.entrypointId} 第 ${round} 轮 HTTP response`,
      risk: "overhead" as const,
    })),
    { id: "http-findings", title: "HTTP Detector Findings", risk: "observe" },
  ];
  const bundle = new EvidenceBundle(staging, outcomes);
  const ctx: HttpCommandContext = {
    command: commandContext,
    config: { intervalMs: intervalSeconds * 1000 },
    target: executionTarget,
    inspectEndpoint: activeInspectEndpoint!,
    staging,
    bundle,
    sendHttp: activeSendHttp!,
    lastRound: 0,
    log: (line) => terminalStderr.info(`${line}\n`),
  };
  let facts!: HttpInspectionFacts;
  let diagnosis!: HttpDiagnosis;
  try {
    terminalStdout.write("[collect] 采集 HTTP Facts…\n");
    facts = await runInspects(
      [makeHttpEndpointInspect(scenario, inspectTimeoutSeconds * 1000)],
      ctx,
      (line) => terminalStdout.write(`${line}\n`),
    );
    bundle.fill("http-endpoint-connectivity", {
      status: facts.endpoints.status === "collected" ? "ok" : "unavailable",
      reason: facts.endpoints.status === "collected" ? undefined : facts.endpoints.reason,
      output: `${JSON.stringify(facts.endpoints, null, 2)}\n`,
      ext: "json",
    });
    writeFileSync(
      join(staging, "scenario.json"),
      `${JSON.stringify(sanitizedScenario(scenario), null, 2)}\n`,
      { mode: 0o600 },
    );

    const engineDiagnosis = await runDiagnosis({
      ctx,
      facts,
      config: ctx.config,
      probes: attempts.map(({ request, round }) => makeHttpRequestProbe(request, round)),
      log: (line) => terminalStdout.write(`${line}\n`),
      buildEvidence: buildHttpEvidence(scenario.requests, repeat),
      detectors: httpDetectors,
      buildCoverage: buildHttpCoverage,
    });
    diagnosis = buildHttpDiagnosis(
      engineDiagnosis.evidence,
      engineDiagnosis.findings,
      engineDiagnosis.coverage,
    );
    bundle.fill("http-findings", {
      status: "ok",
      output: `${JSON.stringify({ findings: diagnosis.findings, coverage: diagnosis.coverage }, null, 2)}\n`,
      ext: "json",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    bundle.settle(reason);
    bundle.writeSummary(`# doctor http diagnosis failed\n\n${reason}\n`);
    bundle.writeManifest({
      doctorVersion: DOCTOR_CLI_VERSION,
      target: {
        scenario: scenario.name,
        execution: executionTarget,
        source: { type: "http_file", file: basename(scenarioFile) },
      },
      inspectionFacts: facts ? { ...facts } : {},
      params: {
        repeat,
        interval_seconds: intervalSeconds,
        inspect_timeout_seconds: inspectTimeoutSeconds,
        output_format: format,
        execution_location: executionTarget.kind,
      },
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    });
    recordFailureBundle({ bundleDir: staging, collectCode: 1, reason });
    return 1;
  }
  const finishedAt = new Date();
  const hasFindings = diagnosis.findings.length > 0;
  writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify({
    observations: diagnosis.observations.map(serializeHttpAttempt),
    summaries: diagnosis.summaries,
    findings: diagnosis.findings.map(serializeFinding),
    coverage: diagnosis.coverage,
  }, null, 2)}\n`, { mode: 0o600 });
  bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    target: {
      scenario: scenario.name,
      execution: executionTarget,
      source: { type: "http_file", file: basename(scenarioFile) },
    },
    inspectionFacts: { ...facts },
    params: {
      repeat,
      interval_seconds: intervalSeconds,
      inspect_timeout_seconds: inspectTimeoutSeconds,
      output_format: format,
      execution_location: executionTarget.kind,
    },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  });
  bundle.writeSummary(buildHttpMarkdown(
    diagnosis,
    scenario.requests,
    scenario.name,
    executionTargetLabel(executionTarget),
    staging,
  ));

  const evidenceOutcome = evaluateCollectOutcome(
    attempts.map(({ request, round }) => diagnosis.observations.some(
      (observation) => observation.requestId === request.requestId
        && observation.entrypointId === request.entrypointId
        && observation.round === round
        && observation.response.captureComplete,
    )),
  );

  const generated = format === "md" || writeHttpArtifact(
    staging,
    reportProfileName,
    buildHttpHtml(diagnosis, scenario.requests, staging, executionTargetLabel(executionTarget)),
  );
  if (!generated) {
    recordFailureBundle({ bundleDir: staging, collectCode: 1, reason: "HTTP 诊断产物生成失败" });
    return 1;
  }
  if (evidenceOutcome.exitCode !== 0) {
    recordFailureBundle({ bundleDir: staging, collectCode: evidenceOutcome.exitCode, reason: "HTTP 证据不完整" });
    terminalStderr.error("[http] 证据不完整\n");
  } else if (hasFindings) {
    terminalStderr.warning("[http] 发现异常\n");
  } else {
    terminalStderr.success("[http] 诊断完成\n");
  }
  return evidenceOutcome.exitCode;
}
