import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { createDoctorProgram, main } from "../src/app/main";
import { DOCTOR_CLI_VERSION } from "../src/app/version";
import { withLogger } from "../src/terminal/log";
import { testPlugin } from "./fixtures/test-plugin";

// CLI 表面断言（help / version / 错误路径 / profile 与 init）全部在进程内完成：
// createDoctorProgram 与真实入口共用同一份构建逻辑；冷启动冒烟见 command-routing.test.ts。
process.env.NO_COLOR = "1";

const roots: string[] = [];
const originalConfig = process.env.DOCTOR_CONFIG;
afterEach(() => {
  if (originalConfig === undefined) delete process.env.DOCTOR_CONFIG;
  else process.env.DOCTOR_CONFIG = originalConfig;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configFile(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-surface-test-"));
  roots.push(root);
  const path = join(root, "config.yaml");
  writeFileSync(path, content);
  return path;
}

function workingDir(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-surface-cwd-"));
  roots.push(root);
  return root;
}

interface CliResult { exitCode: number; stdout: string; stderr: string }

/** 同进程执行 CLI。withPlugin 对应 plugin-cli fixture 的 startDoctor({ plugin })。 */
async function run(args: string[], options: { withPlugin?: boolean; cwd?: string } = {}): Promise<CliResult> {
  const distribution = options.withPlugin ? { plugin: testPlugin } : {};
  let stdout = "";
  let stderr = "";
  const writeOut = spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += String(chunk); return true; });
  const writeErr = spyOn(process.stderr, "write").mockImplementation(chunk => { stderr += String(chunk); return true; });
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  // 隔离用户环境里的继承配置；显式 --config 的用例不受影响
  delete process.env.DOCTOR_CONFIG;
  const previousCwd = process.cwd();
  if (options.cwd) process.chdir(options.cwd);
  const capture = (command: Command): void => {
    command.exitOverride().configureOutput({
      writeOut: text => { stdout += text; },
      writeErr: text => { stderr += text; },
    });
    for (const child of command.commands) capture(child);
  };
  let code = 0;
  try {
    if (args.length === 0) {
      // 裸 doctor 的 help 早退路径在 main() 里（argv.length === 2 → outputHelp）
      const argv = process.argv;
      process.argv = [argv[0]!, "doctor"];
      try { await main(distribution); } finally { process.argv = argv; }
    } else {
      const program = createDoctorProgram(distribution);
      capture(program);
      try {
        await withLogger("info", () => program.parseAsync(args, { from: "user" }));
      } catch (error) {
        // commander 用法错误与 --help/--version 在 exitOverride 下以 CommanderError 抛出
        const exit = (error as { exitCode?: number }).exitCode;
        if (exit === undefined) throw error;
        code = exit;
      }
    }
    if (code === 0) code = process.exitCode ?? 0;
  } finally {
    process.exitCode = previousExitCode;
    if (options.cwd) process.chdir(previousCwd);
    writeOut.mockRestore();
    writeErr.mockRestore();
  }
  return { exitCode: code, stdout, stderr };
}

const runCore = (args: string[] = []) => run(args);
const runWithPlugin = (args: string[] = []) => run(args, { withPlugin: true });

describe("root surface", () => {
  test("core entry advertises Plugin commands", async () => {
    const result = await runCore();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cpu [options]");
    expect(result.stdout).toContain("http [options]");
    expect(result.stdout).toContain("data [options]");
    expect(result.stdout).toContain("store [options]");
    expect(result.stdout).toContain("tenant [options]");
    expect(result.stdout).toContain("model [options]");
    expect(result.stdout).toContain("eval [options]");
    expect(result.stdout).toContain("perf [options]");
    expect(result.stdout).toContain("overview [options]");
    expect(result.stdout).toContain("--debug");
  });

  test("bare doctor only displays help", async () => {
    const result = await runWithPlugin();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor [options] [command]");
    expect(result.stdout).toContain("面向应用与基础设施的本地诊断工具");
    expect(result.stdout).toContain("Core 提供通用 Target 访问与证据编排");
    expect(result.stdout).toContain("Plugin 提供业务目标和数据语义");
    expect(result.stdout).toContain("默认旁路运行、证据优先");
    expect(result.stdout).toContain("chat [options]");
    expect(result.stdout).toContain("init [options]");
    expect(result.stdout).toContain("cpu [options]");
    expect(result.stdout).toContain("mem [options]");
    expect(result.stdout).toContain("mema [options]");
    expect(result.stdout).not.toContain("mems [options]");
    expect(result.stdout).not.toContain("memd [options]");
    expect(result.stderr).toBe("");
  });

  test("curl command has been removed", async () => {
    const result = await runWithPlugin();
    expect(result.stdout).toContain("http [options]");
    expect(result.stdout).not.toContain("curl [options]");
  });

  test("version reports Doctor and the embedded Plugin identity", async () => {
    const core = await runCore(["version"]);
    expect(core.exitCode).toBe(0);
    expect(core.stdout).toContain(`doctor ${DOCTOR_CLI_VERSION}`);
    expect(core.stdout).toContain("plugin none");
    expect(core.stdout).toContain(`os ${process.platform} `);
    expect(core.stdout).toContain(`arch ${process.arch}`);
    expect(core.stdout).toContain(`glibc ${process.platform === "linux" ? "" : "n/a"}`);

    const distribution = await runWithPlugin(["version"]);
    expect(distribution.exitCode).toBe(0);
    expect(distribution.stdout).toContain(`doctor ${DOCTOR_CLI_VERSION}`);
    expect(distribution.stdout).toContain("plugin test@0.0.1");
  });

  test("version flags report only the default distribution identity", async () => {
    for (const flag of ["--version", "-V"]) {
      const result = await runCore([flag]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`doctor ${DOCTOR_CLI_VERSION}\n`);
    }
  });

  for (const command of ["vdb", "ai", "config", "redis", "mems", "memd"]) {
    test(`${command} is removed without a compatibility alias`, async () => {
      const result = await runWithPlugin([command]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`unknown command '${command}'`);
    });
  }

  test("debug rejects the removed deploy subcommand", async () => {
    const removed = await runWithPlugin(["debug", "deploy"]);
    expect(removed.exitCode).not.toBe(0);
    expect(removed.stderr).toContain("too many arguments");
  });
});

describe("capability and preflight errors", () => {
  test("core entry explains a missing Plugin before K8s access", async () => {
    const missing = await runCore(["data", "--biz-id", "biz-1"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("doctor data 需要 Doctor Host 加载 Plugin");
    expect(missing.stderr).not.toContain("Kubernetes");
  });

  test("loaded Plugin missing a required capability reports that capability", async () => {
    const result = await runWithPlugin(["data", "--biz-id", "biz-1"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("extension.facts.inspect");
    expect(result.stderr).toContain("Plugin 'test'");
    expect(result.stderr).toContain("Plugin test@0.0.1");
    expect(result.stderr).not.toContain("Kubernetes");
  });

  test("trace reports a missing traceId capability before Kubernetes access", async () => {
    const result = await runWithPlugin(["trace", "--biz-id", "biz-1"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("extension.trace.resolve");
    expect(result.stderr).not.toContain("Kubernetes");
  });

  test("command validates its profile before resolving Plugin capabilities", async () => {
    const configPath = configFile("profiles:\n  broken:\n    readonly: yes\n");
    const result = await runWithPlugin(["trace", "--biz-id", "biz-1", "--config", configPath]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("profile 'broken'.readonly must be a boolean");
    expect(result.stderr).not.toContain("extension.trace.resolve");
    expect(result.stderr).not.toContain("Kubernetes");
  });

  test("declared environment preparation fails before domain work", async () => {
    const configPath = configFile(
      "profiles:\n  test:\n    readonly: true\n    kube:\n      kubeconfig_path: /doctor/not-found\n",
    );
    const result = await runWithPlugin(["mem", "--config", configPath]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("kubeconfig path not found");
    expect(result.stdout).not.toContain("[collect]");
  });

  test("log rejects invalid time bounds before target access", async () => {
    const invalid = await runCore(["log", "--biz-id", "trace-a", "--until-time", "yesterday"]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toContain("RFC3339");
    expect(invalid.stderr).not.toContain("Kubernetes");
  });

  test("http 在非交互环境未指定 YAML 时给出明确指引", async () => {
    const result = await runWithPlugin(["http"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("缺少 --file");
    expect(result.stderr).toContain("--example");
  });

  test("net 在非交互环境未指定 YAML 时给出明确指引", async () => {
    const result = await runWithPlugin(["net"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("缺少 --file");
    expect(result.stderr).toContain("非交互环境请显式指定 YAML");
  });

  test("mem no longer asks for a mode in non-interactive use", async () => {
    const result = await runWithPlugin(["mem"]);
    expect(result.stderr).toContain("请显式指定 --pod <pod>");
    expect(result.stderr).not.toContain("--mode");
  });

  test("store redis rejects non-positive key budgets before collection", async () => {
    const maxKeys = await runWithPlugin(["store", "--type", "redis", "--max-keys", "0"]);
    expect(maxKeys.exitCode).toBe(2);
    expect(maxKeys.stderr).toContain("--max-keys 需要 >= 1 的整数");

    const rate = await runWithPlugin(["store", "--type", "redis", "--max-keys-per-second", "0"]);
    expect(rate.exitCode).toBe(2);
    expect(rate.stderr).toContain("--max-keys-per-second 需要 >= 1 的整数");

    const database = await runWithPlugin(["store", "--type", "redis", "--database", "-1"]);
    expect(database.exitCode).toBe(2);
    expect(database.stderr).toContain("--database 需要 >= 0 的整数");
  });

  test("data accepts positional biz-id and fails on the missing capability", async () => {
    const positional = await runWithPlugin(["data", "biz-1"]);
    expect(positional.exitCode).not.toBe(0);
    expect(positional.stderr).not.toContain("required option '--biz-id <id>' not specified");
    expect(positional.stderr).toContain("extension.facts.inspect");
  });

  test("install rejects unsupported programs", async () => {
    const unsupported = await runWithPlugin(["install", "--program", "strace"]);
    expect(unsupported.exitCode).not.toBe(0);
    expect(unsupported.stderr).toContain("目前仅支持安装 gdb");
  });

  test("install requires an explicit program without a terminal", async () => {
    const missingProgram = await runWithPlugin(["install"]);
    expect(missingProgram.exitCode).not.toBe(0);
    expect(missingProgram.stderr).toContain("非交互终端；请显式指定 --program gdb");
  });
});

describe("profile and init", () => {
  test("init exits without changing an existing config", async () => {
    const configPath = configFile("default_profile: dev\nprofiles:\n  dev:\n    readonly: true\n");
    const original = readFileSync(configPath, "utf8");

    const result = await runWithPlugin(["init", "--config", configPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("config 已存在，跳过初始化");
    expect(result.stdout).not.toContain("profile: dev");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("profile persists the selected default_profile", async () => {
    const configPath = configFile(
      "default_profile: dev\nprofiles:\n  dev:\n    readonly: true\n  prod:\n    readonly: true\n",
    );

    const result = await runWithPlugin(["profile", "prod", "--config", configPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("profile: dev\n");
    expect(result.stdout).toContain("profile: prod (saved to");
    expect(readFileSync(configPath, "utf8")).toContain("default_profile: prod");
  });

  test("empty config uses default and non-interactive profile lists it", async () => {
    const configPath = configFile("");

    const result = await runWithPlugin(["profile", "--config", configPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("profile: default\n");
    expect(result.stdout).toContain("* default (readonly)");
  });

  test("work commands print the effective one-shot profile first", async () => {
    const configPath = configFile(
      "default_profile: dev\nprofiles:\n  dev:\n    readonly: true\n  prod:\n    readonly: true\n",
    );

    const result = await runWithPlugin(["mem", "--profile", "prod", "--config", configPath]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toStartWith("[info] profile: prod\n");
    expect(readFileSync(configPath, "utf8")).toContain("default_profile: dev");
  });
});

describe("http example generation", () => {
  test("http --example 在当前目录生成可编辑的 example.yaml", async () => {
    const dir = workingDir();

    const result = await run(["http", "--example"], { withPlugin: true, cwd: dir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("示例已生成：example.yaml");
    expect(readFileSync(join(dir, "example.yaml"), "utf-8")).toContain("schema: doctor-http/v1");
  });

  test("http -e 支持指定示例文件路径", async () => {
    const dir = workingDir();

    const result = await run(["http", "-e", "requests.yaml"], { withPlugin: true, cwd: dir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("示例已生成：requests.yaml");
    expect(readFileSync(join(dir, "requests.yaml"), "utf-8")).toContain("schema: doctor-http/v1");
  });
});

describe("command help", () => {
  test("chat is the explicit interactive command", async () => {
    const result = await runWithPlugin(["chat", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor chat [options]");
    expect(result.stdout).toContain("--server");
  });

  test("perf is a top-level bounded load command", async () => {
    const result = await runCore(["perf", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor perf [options]");
    expect(result.stdout).toContain("--levels <numbers>");
    expect(result.stdout).toContain("最大 50；指定后跳过最高并发询问");
    expect(result.stdout).toContain("--max-requests <n>");
    expect(result.stdout).toContain("--trace-samples <n>");
    expect(result.stdout).toContain('(default: "10")');
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout.replace(/\s+/g, " ")).toContain('"html", "bundle", "manifest"');
    expect(result.stdout).toContain("-y, --yes");
  });

  test("eval runs canonical Cases once and only collects evidence", async () => {
    const result = await runCore(["eval", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor eval [options]");
    expect(result.stdout).toContain("--caseset <id>");
    expect(result.stdout).toContain("--cases <ids>");
    expect(result.stdout).toContain("每个执行一次");
    expect(result.stdout).toContain("不做质量评分");
    expect(result.stdout.replace(/\s+/g, " ")).toContain('"html", "bundle", "manifest"');
    expect(result.stdout).toContain("-y, --yes");
  });

  test("collect is an aggregate command rather than another collector", async () => {
    const result = await runCore(["collect", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor collect [options] [biz-ids...]");
    expect(result.stdout).toContain("集合命令");
    expect(result.stdout).toContain("本身不实现具体采集");
    expect(result.stdout).toContain("--include <kinds>");
    expect(result.stdout).toContain("inspect、tenant、data、trace、log、metric");
    expect(result.stdout).toContain("--biz-id <id>");
    expect(result.stdout).toContain("--deployment-config");
    expect(result.stdout).toContain("--dependencies");
    expect(result.stdout).toContain("--watch <duration>");
  });

  test("log defaults to HTML plus a full Evidence Bundle", async () => {
    const result = await runWithPlugin(["log", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--biz-id <id>");
    expect(result.stdout).toContain("[biz-ids...]");
    expect(result.stdout).not.toContain("--id <id>");
    expect(result.stdout).toContain("--until-time <timestamp>");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout.replace(/\s+/g, " ")).toContain('"html", "bundle", "manifest"');
    expect(result.stdout.replace(/\s+/g, " ")).toContain("上游默认 HTML + Bundle");
    expect(result.stdout.replace(/\s+/g, " ")).toContain("新建证据目录");
    expect(result.stdout).toContain("basename/路径");
  });

  test("trace accepts biz-id and treats namespace as the business namespace", async () => {
    const result = await runWithPlugin(["trace", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--biz-id <id>");
    expect(result.stdout).toContain("[biz-ids...]");
    expect(result.stdout).not.toContain("--id <id>");
    expect(result.stdout).toContain("业务 Service 所在 namespace");
    expect(result.stdout).toContain("OpenSearch backend service 覆盖值");
  });

  test("inspect exposes Service workload and Service configuration options", async () => {
    const result = await runWithPlugin(["inspect", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor inspect [options]");
    expect(result.stdout).toContain("检查 Service 的 workload、配置、Toolchain 与应用依赖（只读）");
    expect(result.stdout).toContain("--services <names>");
    expect(result.stdout).toContain("--deployment-config");
    expect(result.stdout).toContain("--dependencies");
    expect(result.stdout).not.toContain("--tenant-id <id>");
    expect(result.stdout).not.toContain("--tenant-config-service <name>");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout.replace(/\s+/g, " ")).toContain('"bundle", "json", "html", "md", "summary", "manifest"');
    expect(result.stdout.replace(/\s+/g, " ")).toContain("上游默认 HTML + Bundle");
  });

  test("tenant exposes tenant-scoped data collection", async () => {
    const result = await runWithPlugin(["tenant", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor tenant [options]");
    expect(result.stdout).toContain("租户粒度业务事实");
    expect(result.stdout).toContain("--tenant-id <id>");
    expect(result.stdout).toContain("--tenant-name <name>");
    expect(result.stdout).not.toContain("--tenant-config-service <name>");
    expect(result.stdout).not.toContain("--model-catalog-service <name>");
    expect(result.stdout).toContain("--tenant-directory-service <name>");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout.replace(/\s+/g, " ")).toContain('"bundle", "json", "html", "summary", "manifest"');
  });

  test("store exposes Service capability selection and backend options", async () => {
    const result = await runWithPlugin(["store", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor store [options]");
    expect(result.stdout).toContain("诊断 DB/VDB/S3/Redis 健康与容量");
    expect(result.stdout).toContain("--type <types>");
    expect(result.stdout).toContain("--pod <pod>");
    expect(result.stdout).toContain("--container <name>");
    expect(result.stdout).toContain("--store <id>");
    expect(result.stdout).toContain("--service <name>");
    expect(result.stdout).toContain("--backend-service <name>");
    expect(result.stdout).toContain("--endpoint <url>");
    expect(result.stdout).toContain("--s3-prefix <prefix>");
    expect(result.stdout).toContain("--s3-max-objects <n>");
    expect(result.stdout).toContain("--s3-scan-timeout <seconds>");
    expect(result.stdout).toContain("--quick");
    expect(result.stdout).toContain("--max-keys <n>");
    expect(result.stdout).toContain("--output <path>");
  });

  test("http exposes scenario repetition and dual-delivery output options", async () => {
    const result = await runWithPlugin(["http", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--location <local|pod>");
    expect(result.stdout).toContain("--pod <pod>");
    expect(result.stdout).toContain("--container <name>");
    expect(result.stdout).toContain("--namespace <ns>");
    expect(result.stdout).toContain("--file <path>");
    expect(result.stdout).toContain("-e, --example [path]");
    expect(result.stdout).toContain("--request <ids>");
    expect(result.stdout).toContain("--repeat <n>");
    expect(result.stdout).toContain("--interval <seconds>");
    expect(result.stdout).toContain("--timeout <seconds>");
    expect(result.stdout).toContain("--inspect-timeout <seconds>");
    expect(result.stdout).toContain("--max-size <mib>");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout).toContain("--kubeconfig <path>");
    expect(result.stdout.replace(/\s+/g, " ")).toContain('"bundle", "html", "md", "manifest"');
    expect(result.stdout.replace(/\s+/g, " ")).toContain("上游默认 HTML + Bundle");
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout).toContain("basename/路径");
  });

  test("net exposes bounded capture options and neta stays local-only", async () => {
    const net = await runWithPlugin(["net", "--help"]);
    expect(net.exitCode).toBe(0);
    expect(net.stdout).toContain("--file <path>");
    expect(net.stdout).toContain("守候模式");
    expect(net.stdout).toContain("--services <names>");
    expect(net.stdout).toContain("--max-pcap-size <mib>");
    expect(net.stdout).toContain("--max-response-size <mib>");
    expect(net.stdout).toContain("--cleanup-remote");
    const neta = await runWithPlugin(["neta", "--help"]);
    expect(neta.exitCode).toBe(0);
    expect(neta.stdout).toContain("Usage: doctor neta [options] [input]");
    expect(neta.stdout).toContain("--trace-id <ids>");
    expect(neta.stdout).toContain("Markdown、HTML 与 JSON");
    expect(neta.stdout).toContain("Global Options:");
    expect(neta.stdout).toContain("--kubeconfig");
  });

  test("mcp exposes server/tool selection and selectable Bundle/HTML output", async () => {
    const result = await runWithPlugin(["mcp", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("对 MCP tool 执行多维取证与规则分析");
    expect(result.stdout).toContain("--server <name>");
    expect(result.stdout).toContain("--tool <name>");
    expect(result.stdout).toContain("--args <json>");
    expect(result.stdout).toContain("--gateway-service <name>");
    expect(result.stdout).not.toContain("--model-catalog-service <name>");
    expect(result.stdout).toContain("-y, --yes");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout.replace(/\s+/g, " ")).toContain("上游默认 HTML + Bundle");
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout.replace(/\s+/g, " ")).toContain("同名 .html 与 .tar.gz");
  });

  test("model exposes tenant/model selection and inference diagnosis options", async () => {
    const result = await runWithPlugin(["model", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("从模型目录选择可用模型，执行 validation 与真实 inference");
    expect(result.stdout).toContain("--tenant-id <id>");
    expect(result.stdout).toContain("--tenant-name <name>");
    expect(result.stdout).toContain("--model <id|name>");
    expect(result.stdout).toContain("--type <type>");
    expect(result.stdout).toContain("--model-catalog-service <name>");
    expect(result.stdout).toContain("--tenant-directory-service <name>");
    expect(result.stdout).toContain("--timeout <seconds>");
    expect(result.stdout).toContain("--performance");
    expect(result.stdout).toContain("--no-performance");
    expect(result.stdout).toContain("--repeat <n>");
    expect(result.stdout).toContain("--max-output-tokens <n>");
    expect(result.stdout).toContain("-f, --format <format>");
    expect(result.stdout.replace(/\s+/g, " ")).toContain("上游默认 HTML + Bundle");
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout.replace(/\s+/g, " ")).toContain("同名 .html 与 .tar.gz");
  });

  test("mem uses PyHeap without exposing backend selection or historical modes", async () => {
    const result = await runWithPlugin(["mem", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("-p, --pod <pod>");
    expect(result.stdout).toContain("--detail <detail>");
    expect(result.stdout).not.toContain("--backend <backend>");
    expect(result.stdout).toContain("--capture-via <strategy>");
    expect(result.stdout).toContain("debug-container 或");
    expect(result.stdout).toContain("target-container");
    expect(result.stdout).toContain("--transfer-chunk-size <size>");
    expect(result.stdout).toContain("--cleanup-remote");
    expect(result.stdout).toContain("-y, --yes");
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout).not.toContain("--mode <mode>");
    expect(result.stdout).not.toContain("--interval");
    expect(result.stdout).not.toContain("--format");
  });

  test("image publication exposes registry and source options", async () => {
    const result = await runWithPlugin(["image", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor image [options] [image]");
    expect(result.stdout).toContain("--tar <path>");
    expect(result.stdout).toContain("--source-image <image>");
    expect(result.stdout).toContain("--registry");
    expect(result.stdout).toContain("--host");
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).toContain("--kubeconfig <path>");
    expect(result.stdout).toContain("--profile <name>");
    expect(result.stdout).not.toContain("--arch <arch>");
    expect(result.stdout).not.toContain("--engine <engine>");
  });

  test("debug deployment has its own command scope", async () => {
    const debug = await runWithPlugin(["debug", "--help"]);
    expect(debug.stdout).toContain("Usage: doctor debug [options]");
    expect(debug.stdout).toContain("--image <image>");
    expect(debug.stdout).not.toContain("--tar <path>");
    expect(debug.stdout).toContain("--services <names>");
    expect(debug.stdout).not.toContain("GDB 安装");
    expect(debug.stdout).not.toContain("--debug-container <name>");
  });

  test("install targets an explicit Pod container and only exposes GDB", async () => {
    const result = await runWithPlugin(["install", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor install [options]");
    expect(result.stdout).toContain("首版支持 GDB");
    expect(result.stdout).toContain("--program <name>");
    expect(result.stdout).toContain("--pod <pod>");
    expect(result.stdout).toContain("--container <name>");
    expect(result.stdout).toContain("--tar <path>");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).not.toContain("debug container");
  });

  test("mema is a local-only analysis command", async () => {
    const result = await runWithPlugin(["mema", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor mema [options] [inputs...]");
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout).not.toContain("--mode <mode>");
    expect(result.stdout).not.toContain("--pod <pod>");
    expect(result.stdout).not.toContain("--format");
    expect(result.stdout).not.toContain("--snapshot");
  });

  test("cpu exposes pod、pid、mode and bundle output options", async () => {
    const result = await runWithPlugin(["cpu", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor cpu [options]");
    expect(result.stdout).toContain("-p, --pod <pod>");
    expect(result.stdout).toContain("--pid <pid>");
    expect(result.stdout).toContain("--mode <mode>");
    expect(result.stdout).not.toContain("--debug-container <name>");
    expect(result.stdout).toContain("-y, --yes");
    expect(result.stdout).toContain("-o, --output <path>");
    expect(result.stdout).not.toContain("--interval");
    expect(result.stdout).not.toContain("--metrics-port");
  });

  test("store exposes Redis bounded scan modes without credential overrides", async () => {
    const result = await runWithPlugin(["store", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--service <name>");
    expect(result.stdout).toContain("--store <id>");
    expect(result.stdout).not.toContain("--url <url>");
    expect(result.stdout).toContain("--database <n>");
    expect(result.stdout).toContain("未指定时交互选择");
    expect(result.stdout).toContain("-p, --pod <pod>");
    expect(result.stdout).toContain("-c, --container <name>");
    expect(result.stdout).not.toContain("--deployment");
    expect(result.stdout).toContain("--quick");
    expect(result.stdout).toContain("--max-keys <n>");
    expect(result.stdout).toContain("--max-keys-per-second <n>");
    expect(result.stdout).not.toContain("--full");
    expect(result.stdout).not.toContain("--scan-count");
    expect(result.stdout).not.toContain("--sleep-ms");
    expect(result.stdout).toContain("--show-key-names");
    expect(result.stdout).toContain("--no-show-key-names");
    expect(result.stdout).toContain("隐藏完整 key 名并使用哈希摘要");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout.replace(/\s+/g, " ")).toContain('"bundle", "html", "md", "manifest"');
    expect(result.stdout.replace(/\s+/g, " ")).toContain("上游默认 HTML + Bundle");
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout).toContain("同名 .html 与 .tar.gz");
  });

  test("data accepts positional or repeated biz-id and exposes JSON and HTML", async () => {
    const result = await runWithPlugin(["data", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor data [options] [biz-ids...]");
    expect(result.stdout).toContain("--biz-id <id>");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout.replace(/\s+/g, " ")).toContain('"bundle", "json", "html", "summary", "manifest"');
    expect(result.stdout.replace(/\s+/g, " ")).toContain("新建证据目录");
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout).toContain("同名 .html 与 .tar.gz");
  });

  test("db exposes Service-scoped operations", async () => {
    const db = await runWithPlugin(["db", "--help"]);
    expect(db.exitCode).toBe(0);
    expect(db.stdout).toContain("--show-databases");
    expect(db.stdout).not.toContain("--no-interactive");
    expect(db.stdout).not.toContain("--store");
  });

  for (const command of ["data", "store", "db", "http", "mcp", "trace"]) {
    test(`${command} exposes -f shorthand`, async () => {
      const result = await runWithPlugin([command, "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("-f, --format <format>");
    });
  }
});
