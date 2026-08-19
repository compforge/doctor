import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marked, Renderer } from "marked";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { EvidenceBundle, type OutcomeDecl } from "../evidence";
import { packReportBundle, resolveDefaultReportPaths } from "../output/archive";
import { deliverFailureBundle } from "../output/failure-bundle";
import { escapeHtml, writeHtmlReport, type HtmlReportOptions } from "../output/html";
import { resolveStoreOutputPath, type StoreConfig, type StoreOutputFormat } from "./config";

export type StoreHtmlReportOptions = Pick<
  HtmlReportOptions,
  "sections"
>;

function timestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export interface StoreBundle {
  bundle: EvidenceBundle;
  bundleName: string;
  staging: string;
  outputPath: string;
  startedAt: string;
}

export function createStoreBundle(
  kind: string,
  output: string | undefined,
  format: StoreOutputFormat,
  outcomes: readonly OutcomeDecl[],
): StoreBundle {
  const bundleName = `doctor-store-${kind}-${timestamp(new Date())}`;
  const staging = join(mkdtempSync(join(tmpdir(), `doctor-store-${kind}-`)), bundleName);
  return {
    bundle: new EvidenceBundle(staging, outcomes),
    bundleName,
    staging,
    outputPath: resolveStoreOutputPath(output, bundleName, format),
    startedAt: new Date().toISOString(),
  };
}

export async function deliverStoreArtifacts(input: {
  staging: string;
  bundleName: string;
  outputPath: string;
  requestedOutput?: string;
  format: StoreOutputFormat;
  code: number;
  title: string;
  profileName: string;
  summary: string;
  htmlReport?: StoreHtmlReportOptions;
}): Promise<{ ok: boolean; path: string; label: string }> {
  if (input.code !== 0) {
    const failure = await deliverFailureBundle({
      bundleDir: input.staging,
      bundleName: input.bundleName,
      requestedOutput: input.format === "default"
        ? resolveDefaultReportPaths(input.requestedOutput, input.bundleName).bundle
        : input.requestedOutput,
      collectCode: input.code,
    });
    return { ok: failure.packed.ok, path: failure.path, label: "失败 Evidence Bundle" };
  }
  try {
    const writeReport = (path: string) => {
      const renderer = new Renderer();
      renderer.html = ({ text }) => escapeHtml(text);
      writeHtmlReport(input.staging, path, {
        ...input.htmlReport,
        title: input.title,
        profileName: input.profileName,
        // Markdown inline/code 由 marked 自身转义；raw HTML 单独收口，避免现场文本注入报告。
        summaryHtml: marked.parse(input.summary, { async: false, renderer }) as string,
      });
    };
    if (input.format === "html") {
      writeReport(input.outputPath);
      return { ok: true, path: input.outputPath, label: "Store HTML 报告" };
    }
    if (input.format === "bundle" || input.format === "default") {
      const reportPath = join(input.staging, "report.html");
      writeReport(reportPath);
      const paths = input.format === "default"
        ? resolveDefaultReportPaths(input.requestedOutput, input.bundleName)
        : { html: reportPath, bundle: input.outputPath };
      if (input.format === "default") copyFileSync(reportPath, paths.html);
      const packed = await packReportBundle(input.staging, paths.bundle);
      return {
        ok: packed.ok,
        path: input.format === "default" ? `${paths.html} + ${paths.bundle}` : paths.bundle,
        label: input.format === "default" ? "Store HTML + 证据包" : "Store 证据包",
      };
    }
    copyFileSync(join(input.staging, "summary.md"), input.outputPath);
    return { ok: true, path: input.outputPath, label: "Store Markdown 报告" };
  } catch (error) {
    terminalStderr.error(`[collect] Store 产物生成失败：${error instanceof Error ? error.message : String(error)}\n`);
    return { ok: false, path: input.outputPath, label: "Store 产物" };
  }
}

export async function deliverStoreBundle(input: {
  state: StoreBundle;
  config: StoreConfig;
  code: number;
  summary: string;
  inspectionFacts: Record<string, unknown>;
  htmlReport?: StoreHtmlReportOptions;
}): Promise<number> {
  const { state, config } = input;
  state.bundle.settle(input.code === 0 ? "本轮未取得该项证据" : "上游步骤失败，未执行");
  state.bundle.writeSummary(input.summary);
  state.bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    target: {
      namespace: config.collect.kubernetes.namespace,
      service: config.service,
      pod: config.target.pod,
      container: config.target.container,
      store: config.capability.id,
      store_kind: config.capability.kind,
    },
    inspectionFacts: input.inspectionFacts,
    params: {
      namespace: config.collect.kubernetes.namespace,
      service: config.service,
      store: config.capability.id,
      store_kind: config.capability.kind,
    },
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
  });
  const delivery = await deliverStoreArtifacts({
    staging: state.staging,
    bundleName: state.bundleName,
    outputPath: state.outputPath,
    requestedOutput: config.output,
    format: config.outputFormat,
    code: input.code,
    title: `doctor ${config.capability.kind.toUpperCase()} Store 诊断报告`,
    profileName: config.collect.profileName,
    summary: input.summary,
    htmlReport: input.htmlReport,
  });
  if (!delivery.ok) {
    terminalStderr.error(`[collect] 交付失败，证据保留在目录: ${state.staging}\n`);
    return 1;
  }
  rmSync(join(state.staging, ".."), { recursive: true, force: true });
  if (!config.deferDelivery) {
    const message = `[collect] ${delivery.label}: ${delivery.path}\n`;
    if (input.code === 0) terminalStdout.success(message);
    else terminalStderr.error(message);
  }
  return input.code;
}
