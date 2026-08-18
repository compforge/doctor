import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR_CLI_VERSION } from "../src/app/version";

const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI_ENTRY = join(CLI_DIR, "tests/fixtures/plugin-cli.ts");
const CORE_CLI_ENTRY = join(CLI_DIR, "src/app/entry.ts");

function runCliFrom(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", CLI_ENTRY, ...args],
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runCli(...args: string[]) {
  return runCliFrom(CLI_DIR, ...args);
}

function runCoreCli(...args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", CORE_CLI_ENTRY, ...args],
    cwd: CLI_DIR,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("CLI command routing", () => {
  test("core entry advertises Plugin commands", () => {
    const result = runCoreCli();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cpu [options]");
    expect(result.stdout).toContain("http [options]");
    expect(result.stdout).toContain("data [options]");
    expect(result.stdout).toContain("store [options]");
    expect(result.stdout).toContain("model [options]");
    expect(result.stdout).toContain("perf [options]");
    expect(result.stdout).toContain("--debug");
  });

  test("core entry explains a missing Plugin before K8s access", () => {
    const missing = runCoreCli("data", "--biz-id", "biz-1");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("doctor data 需要 Doctor Host 加载 Plugin");
    expect(missing.stderr).not.toContain("Kubernetes");
  });

  test("version reports Doctor and the embedded Plugin identity", () => {
    const core = runCoreCli("version");
    expect(core.exitCode).toBe(0);
    expect(core.stdout).toContain(`doctor ${DOCTOR_CLI_VERSION}`);
    expect(core.stdout).toContain("plugin none");

    const distribution = runCli("version");
    expect(distribution.exitCode).toBe(0);
    expect(distribution.stdout).toContain(`doctor ${DOCTOR_CLI_VERSION}`);
    expect(distribution.stdout).toContain("plugin test@0.0.1");
  });

  test("loaded Plugin missing a required capability reports that capability", () => {
    const result = runCli("data", "--biz-id", "biz-1");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("service.data");
    expect(result.stderr).toContain("Plugin 'test'");
    expect(result.stderr).toContain("Plugin test@0.0.1");
    expect(result.stderr).not.toContain("Kubernetes");
  });

  test("trace reports a missing traceId capability before Kubernetes access", () => {
    const result = runCli("trace", "--biz-id", "biz-1");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("service.traceId");
    expect(result.stderr).not.toContain("Kubernetes");
  });

  test("command validates its profile before resolving Plugin capabilities", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-preflight-config-test-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "profiles:\n  broken:\n    readonly: yes\n");

    const result = runCli("trace", "--biz-id", "biz-1", "--config", configPath);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("profile 'broken'.readonly must be a boolean");
    expect(result.stderr).not.toContain("service.traceId");
    expect(result.stderr).not.toContain("Kubernetes");
  });

  test("bare doctor only displays help", () => {
    const result = runCli();
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

  test("chat is the explicit interactive command", () => {
    const result = runCli("chat", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor chat [options]");
    expect(result.stdout).toContain("--server");
  });

  test("perf is a top-level bounded load command", () => {
    const result = runCoreCli("perf", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor perf [options]");
    expect(result.stdout).toContain("--levels <numbers>");
    expect(result.stdout).toContain("最大 50；指定后跳过最高并发询问");
    expect(result.stdout).toContain("--max-requests <n>");
    expect(result.stdout).toContain("--trace-samples <n>");
    expect(result.stdout).toContain('(default: "10")');
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout).toContain("html 或 bundle");
    expect(result.stdout).toContain("-y, --yes");
  });

  test("collect is an aggregate command rather than another collector", () => {
    const result = runCoreCli("collect", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor collect [options] [biz-ids...]");
    expect(result.stdout).toContain("集合命令");
    expect(result.stdout).toContain("本身不实现具体采集");
    expect(result.stdout).toContain("--include <kinds>");
    expect(result.stdout).toContain("data、trace、log、metric");
    expect(result.stdout).toContain("--biz-id <id>");
    expect(result.stdout).toContain("--watch <duration>");
  });

  test("log exposes HTML-by-default and full Evidence Bundle output", () => {
    const result = runCli("log", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--biz-id <id>");
    expect(result.stdout).toContain("[biz-ids...]");
    expect(result.stdout).not.toContain("--id <id>");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout).toContain("html 或 bundle");
    expect(result.stdout.replace(/\s+/g, " ")).toContain('(default: "html")');
    expect(result.stdout).toContain("JSONL 和 raw");
  });

  test("trace accepts biz-id and treats namespace as the business namespace", () => {
    const result = runCli("trace", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--biz-id <id>");
    expect(result.stdout).toContain("[biz-ids...]");
    expect(result.stdout).not.toContain("--id <id>");
    expect(result.stdout).toContain("业务 Service 所在 namespace");
    expect(result.stdout).toContain("OpenSearch backend service 覆盖值");
  });

  test("config exposes Service runtime and optional tenant inspection options", () => {
    const result = runCli("config", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor config [options]");
    expect(result.stdout).toContain("采集 Service 的 Pod 运行态、Toolchain、可选配置与应用依赖（只读）");
    expect(result.stdout).toContain("--services <names>");
    expect(result.stdout).toContain("--deployment-config");
    expect(result.stdout).toContain("--dependencies");
    expect(result.stdout).toContain("--tenant-id <id>");
    expect(result.stdout).toContain("--tenant-name <name>");
    expect(result.stdout).toContain("--tenant-directory-service <name>");
    expect(result.stdout).toContain("--tenant-directory-port <port>");
    expect(result.stdout).toContain("--tenant-config-service <name>");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout).toContain("html 或 md");
    expect(result.stdout.replace(/\s+/g, " ")).toContain('(default: "html")');
  });

  test("store exposes Service capability selection and backend options", () => {
    const result = runCli("store", "--help");
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

  test("vdb command has been removed", () => {
    const result = runCli("vdb");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown command 'vdb'");
  });

  test("init exits without changing an existing config", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-init-command-test-"));
    const configPath = join(dir, "config.yaml");
    const original = "default_profile: dev\nprofiles:\n  dev:\n    readonly: true\n";
    writeFileSync(configPath, original);

    const result = runCli("init", "--config", configPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("config 已存在，跳过初始化");
    expect(result.stdout).not.toContain("profile: dev");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("profile persists the selected default_profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-profile-command-test-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      "default_profile: dev\nprofiles:\n  dev:\n    readonly: true\n  prod:\n    readonly: true\n",
    );

    const result = runCli("profile", "prod", "--config", configPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("profile: dev\n");
    expect(result.stdout).toContain("profile: prod (saved to");
    expect(readFileSync(configPath, "utf8")).toContain("default_profile: prod");
  });

  test("empty config uses default and non-interactive profile lists it", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-profile-empty-test-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "");

    const result = runCli("profile", "--config", configPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("profile: default\n");
    expect(result.stdout).toContain("* default (readonly)");
  });

  test("work commands print the effective one-shot profile first", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-working-profile-test-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      "default_profile: dev\nprofiles:\n  dev:\n    readonly: true\n  prod:\n    readonly: true\n",
    );

    const result = runCli("mem", "--profile", "prod", "--config", configPath);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toStartWith("profile: prod\n");
    expect(readFileSync(configPath, "utf8")).toContain("default_profile: dev");
  });

  test("declared environment preparation fails before domain work", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-preflight-environment-test-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      "profiles:\n  test:\n    readonly: true\n    kube:\n      kubeconfig_path: /doctor/not-found\n",
    );

    const result = runCli("mem", "--config", configPath);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("kubeconfig path not found");
    expect(result.stdout).not.toContain("[collect]");
  });

  test("ai is no longer a command", () => {
    const result = runCli("ai");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown command 'ai'");
  });

  test("http exposes scenario repetition and HTML-by-default output options", () => {
    const result = runCli("http", "--help");
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
    expect(result.stdout).toContain("bundle（含 HTML 和原始响应）、html 或 md");
    expect(result.stdout).toContain("default:");
    expect(result.stdout).toContain('"html")');
    expect(result.stdout).toContain("--output <path>");
  });

  test("http --example 在当前目录生成可编辑的 example.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-http-example-command-"));

    const result = runCliFrom(dir, "http", "--example");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("示例已生成：example.yaml");
    expect(readFileSync(join(dir, "example.yaml"), "utf-8")).toContain("schema: doctor-http/v1");
  });

  test("http -e 支持指定示例文件路径", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-http-example-short-command-"));

    const result = runCliFrom(dir, "http", "-e", "requests.yaml");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("示例已生成：requests.yaml");
    expect(readFileSync(join(dir, "requests.yaml"), "utf-8")).toContain("schema: doctor-http/v1");
  });

  test("http 在非交互环境未指定 YAML 时给出明确指引", () => {
    const result = runCli("http");

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("缺少 --file");
    expect(result.stderr).toContain("--example");
  });

  test("curl command has been removed", () => {
    const result = runCli();
    expect(result.stdout).toContain("http [options]");
    expect(result.stdout).not.toContain("curl [options]");
  });

  test("net exposes bounded capture options and neta stays local-only", () => {
    const net = runCli("net", "--help");
    expect(net.exitCode).toBe(0);
    expect(net.stdout).toContain("--file <path>");
    expect(net.stdout).toContain("守候模式");
    expect(net.stdout).toContain("--services <names>");
    expect(net.stdout).toContain("--max-pcap-size <mib>");
    expect(net.stdout).toContain("--max-response-size <mib>");
    expect(net.stdout).toContain("--cleanup-remote");
    const neta = runCli("neta", "--help");
    expect(neta.exitCode).toBe(0);
    expect(neta.stdout).toContain("Usage: doctor neta [options] [input]");
    expect(neta.stdout).toContain("--trace-id <ids>");
    expect(neta.stdout).toContain("Markdown、HTML 与 JSON");
    expect(neta.stdout).not.toContain("--kubeconfig");
  });

  test("net 在非交互环境未指定 YAML 时给出明确指引", () => {
    const result = runCli("net");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("缺少 --file");
    expect(result.stderr).toContain("非交互环境请显式指定 YAML");
  });

  test("mcp exposes server/tool selection and selectable Bundle/HTML output", () => {
    const result = runCli("mcp", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("对 MCP tool 执行多维取证与规则分析");
    expect(result.stdout).toContain("--server <name>");
    expect(result.stdout).toContain("--tool <name>");
    expect(result.stdout).toContain("--args <json>");
    expect(result.stdout).toContain("--gateway-service <name>");
    expect(result.stdout).not.toContain("--model-catalog-service <name>");
    expect(result.stdout).toContain("-y, --yes");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout).toContain('(default: "bundle")');
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout).toContain("doctor-mcp-YYYYMMDDHHmmss.tar.gz");
    expect(result.stdout).toContain("--format 自动补全");
  });

  test("model exposes tenant/model selection and inference diagnosis options", () => {
    const result = runCli("model", "--help");
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
    expect(result.stdout).toContain('(default: "json")');
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout).toContain("--format 自动补全");
  });

  test("mem uses PyHeap without exposing backend selection or historical modes", () => {
    const result = runCli("mem", "--help");
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

  test("mem no longer asks for a mode in non-interactive use", () => {
    const result = runCli("mem");
    expect(result.stderr).toContain("请显式指定 --pod <pod>");
    expect(result.stderr).not.toContain("--mode");
  });

  test("historical mems and memd commands have been removed", () => {
    for (const command of ["mems", "memd"]) {
      const result = runCli(command);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`unknown command '${command}'`);
    }
  });

  test("image publication and debug deployment have separate command scopes", () => {
    const result = runCli("image", "--help");
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
    const debug = runCli("debug", "--help");
    expect(debug.stdout).toContain("Usage: doctor debug [options]");
    expect(debug.stdout).toContain("--image <image>");
    expect(debug.stdout).not.toContain("--tar <path>");
    expect(debug.stdout).toContain("--services <names>");
    expect(debug.stdout).not.toContain("GDB 安装");
    expect(debug.stdout).not.toContain("--debug-container <name>");
    const removed = runCli("debug", "deploy");
    expect(removed.exitCode).not.toBe(0);
    expect(removed.stderr).toContain("too many arguments");
  });

  test("install targets an explicit Pod container and only exposes GDB", () => {
    const result = runCli("install", "--help");
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
    const unsupported = runCli("install", "--program", "strace");
    expect(unsupported.exitCode).not.toBe(0);
    expect(unsupported.stderr).toContain("目前仅支持安装 gdb");
    const missingProgram = runCli("install");
    expect(missingProgram.exitCode).not.toBe(0);
    expect(missingProgram.stderr).toContain("非交互终端；请显式指定 --program gdb");
  });

  test("mema is a local-only analysis command", () => {
    const result = runCli("mema", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor mema [options] [inputs...]");
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout).not.toContain("--mode <mode>");
    expect(result.stdout).not.toContain("--pod <pod>");
    expect(result.stdout).not.toContain("--format");
    expect(result.stdout).not.toContain("--snapshot");
  });

  test("cpu exposes pod、pid、mode and bundle output options", () => {
    const result = runCli("cpu", "--help");
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

  test("store exposes Redis bounded scan modes without credential overrides", () => {
    const result = runCli("store", "--help");
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
    expect(result.stdout).toContain("bundle、html 或 md");
    expect(result.stdout).toContain('"html")');
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout).toContain("doctor-store-<type>-<时间戳>.html");
    expect(result.stdout).toContain("--format 自动补全");
  });

  test("store redis rejects non-positive key budgets before collection", () => {
    const maxKeys = runCli("store", "--type", "redis", "--max-keys", "0");
    expect(maxKeys.exitCode).toBe(2);
    expect(maxKeys.stderr).toContain("--max-keys 需要 >= 1 的整数");

    const rate = runCli("store", "--type", "redis", "--max-keys-per-second", "0");
    expect(rate.exitCode).toBe(2);
    expect(rate.stderr).toContain("--max-keys-per-second 需要 >= 1 的整数");

    const database = runCli("store", "--type", "redis", "--database", "-1");
    expect(database.exitCode).toBe(2);
    expect(database.stderr).toContain("--database 需要 >= 0 的整数");
  }, 10_000);

  test("data accepts positional or repeated biz-id and exposes JSON and HTML", () => {
    const result = runCli("data", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor data [options] [biz-ids...]");
    expect(result.stdout).toContain("--biz-id <id>");
    expect(result.stdout).toContain("--format <format>");
    expect(result.stdout).toContain("输出格式：json 或 html");
    expect(result.stdout).toContain("--output <path>");
    expect(result.stdout).toContain("doctor-data-<时间戳>.<format>");
    expect(result.stdout).toContain("自动补全）");

    const positional = runCli("data", "biz-1");
    expect(positional.exitCode).not.toBe(0);
    expect(positional.stderr).not.toContain("required option '--biz-id <id>' not specified");
    expect(positional.stderr).toContain("service.data");
  });

  test("standalone db and redis commands have been removed", () => {
    for (const command of ["db", "redis"]) {
      const result = runCli(command);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`unknown command '${command}'`);
    }
  });

  test("commands with selectable output format expose -f shorthand", () => {
    for (const command of ["data", "store", "http", "mcp", "trace"]) {
      const result = runCli(command, "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("-f, --format <format>");
    }
  }, 10_000);
});
