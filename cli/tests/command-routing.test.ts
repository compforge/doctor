import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR_CLI_VERSION } from "../src/app/version";

// 冷启动冒烟层：只验证真实进程入口可加载、Plugin 经 startDoctor 接入、
// 错误路径以正确 exit code 结束。CLI 表面（help / version / 错误文案 / profile）
// 的完整断言在进程内的 command-surface.test.ts。
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

describe("CLI 冷启动冒烟", () => {
  test("core entry 可加载并打印 bare help", () => {
    const result = runCoreCli();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: doctor [options] [command]");
    expect(result.stdout).toContain("data [options]");
  });

  test("plugin fixture 经 startDoctor 加载并报告 Plugin 身份", () => {
    const result = runCli("version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`doctor ${DOCTOR_CLI_VERSION}`);
    expect(result.stdout).toContain("plugin test@0.0.1");
  });

  test("capability 错误在真实进程中以 exit 1 结束", () => {
    const result = runCli("data", "--biz-id", "biz-1");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("extension.facts.inspect");
  });

  test("输入校验错误在真实进程中以 exit 2 结束", () => {
    const result = runCoreCli("log", "--biz-id", "trace-a", "--until-time", "yesterday");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("RFC3339");
  });
});
