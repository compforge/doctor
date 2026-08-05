import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { REDIS_DEFAULTS, runCollectRedis } from "../redis";
import {
  parseStoreOutputFormat,
  resolveStoreOutputPath,
  resolveStoreConfig,
  resolveStoreKinds,
  type CollectStoreCliOpts,
} from "./config";
import { runStoreDb } from "./db";
import { runStoreS3 } from "./s3";
import { defaultStoreReportName, failedStoreTab, type StoreReportTab, writeTabbedStoreReport } from "./tabs";
import { runStoreVdb } from "./vdb";

export async function runCollectStore(
  opts: CollectStoreCliOpts,
  plugin: PluginDefinition,
  commandContext?: CommandContext,
): Promise<number> {
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
  let kinds;
  try {
    kinds = await resolveStoreKinds(opts.type, plugin, interactive);
  } catch (error) {
    terminalStderr.error(`[collect] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!kinds) return 130;
  let format;
  try {
    format = parseStoreOutputFormat(opts.format);
  } catch (error) {
    terminalStderr.error(`[collect] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const tabbedHtml = kinds.length > 1 && format === "html";
  if (kinds.length > 1 && opts.output && !tabbedHtml) {
    terminalStderr.error("[collect] 一次诊断多个 Store 类型时不能指定 --output；各诊断将使用默认输出路径\n");
    return 2;
  }
  const batchName = tabbedHtml ? defaultStoreReportName(new Date()) : undefined;
  let tabbedOutput: string | undefined;
  let tabbedStaging: string | undefined;
  if (tabbedHtml) {
    try {
      tabbedOutput = resolveStoreOutputPath(opts.output, batchName!, "html");
      tabbedStaging = mkdtempSync(join(tmpdir(), "doctor-store-tabs-"));
    } catch (error) {
      terminalStderr.error(`[collect] ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  const tabs: StoreReportTab[] = [];
  let exitCode = 0;
  for (const kind of kinds) {
    let code: number;
    const kindOutput = tabbedStaging ? join(tabbedStaging, kind) : opts.output;
    const kindOpts = tabbedHtml
      ? { ...opts, format: "html", output: kindOutput, deferDelivery: true }
      : opts;
    if (kind === "redis") {
      code = await runCollectRedis({
        ...kindOpts,
        maxKeys: kindOpts.maxKeys ?? String(REDIS_DEFAULTS.maxKeys),
        maxKeysPerSecond: kindOpts.maxKeysPerSecond ?? String(REDIS_DEFAULTS.maxKeysPerSecond),
        top: kindOpts.top ?? String(REDIS_DEFAULTS.top),
      }, undefined, undefined, commandContext, plugin.services);
    } else {
      let resolved;
      try {
        resolved = await resolveStoreConfig({ ...kindOpts, type: kind }, plugin, commandContext);
      } catch (error) {
        terminalStderr.error(`[collect] ${error instanceof Error ? error.message : String(error)}\n`);
        code = 2;
        exitCode = Math.max(exitCode, code);
        if (tabbedHtml) tabs.push(failedStoreTab(kind));
        continue;
      }
      if (!resolved) {
        if (tabbedStaging) rmSync(tabbedStaging, { recursive: true, force: true });
        return 130;
      }
      const { config, executor } = resolved;
      if (config.capability.kind === "db") code = await runStoreDb(config, executor);
      else if (config.capability.kind === "vdb") code = await runStoreVdb(config, executor);
      else code = await runStoreS3(config, executor);
    }
    if (code === 130) {
      if (tabbedStaging) rmSync(tabbedStaging, { recursive: true, force: true });
      return code;
    }
    if (tabbedHtml) {
      const htmlPath = `${kindOutput}.html`;
      if (code === 0 && existsSync(htmlPath)) {
        tabs.push({ kind, status: "delivered", html: readFileSync(htmlPath, "utf8") });
      } else {
        const temporaryBundle = `${kindOutput}.tar.gz`;
        let failurePath: string | undefined;
        if (existsSync(temporaryBundle)) {
          failurePath = resolveStoreOutputPath(undefined, `${batchName}-${kind}`, "bundle");
          copyFileSync(temporaryBundle, failurePath);
          unlinkSync(temporaryBundle);
        }
        tabs.push(failedStoreTab(kind, failurePath));
      }
    }
    exitCode = Math.max(exitCode, code);
  }
  if (tabbedHtml) {
    try {
      writeTabbedStoreReport(tabbedOutput!, tabs);
      rmSync(tabbedStaging!, { recursive: true, force: true });
      terminalStdout.success(`[collect] Store HTML 报告: ${tabbedOutput}\n`);
    } catch (error) {
      terminalStderr.error(`[collect] Store Tab 报告生成失败：${error instanceof Error ? error.message : String(error)}\n`);
      terminalStderr.error(`[collect] 各 Store 临时报告保留在目录: ${tabbedStaging}\n`);
      return 1;
    }
  }
  return exitCode;
}

export * from "./config";
export * from "./db";
export * from "./s3";
export * from "./s3-inventory";
export * from "./tabs";
export * from "./vdb";
