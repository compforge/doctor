import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveErrorLogPath, writeErrorLog } from "../src/app/error-log";

const originalErrorLog = process.env.DOCTOR_ERROR_LOG;
const originalDebug = process.env.DOCTOR_DEBUG;

afterEach(() => {
  if (originalErrorLog === undefined) delete process.env.DOCTOR_ERROR_LOG;
  else process.env.DOCTOR_ERROR_LOG = originalErrorLog;
  if (originalDebug === undefined) delete process.env.DOCTOR_DEBUG;
  else process.env.DOCTOR_DEBUG = originalDebug;
});

test("writeErrorLog 追加 context 与完整 stack，不记录命令参数", () => {
  const path = join(mkdtempSync(join(tmpdir(), "doctor-error-log-")), "nested", "error.log");
  process.env.DOCTOR_ERROR_LOG = path;
  const secretArg = "redis://user:secret@redis.example.test:6379/0";
  const originalArgv = process.argv;
  process.argv = [originalArgv[0]!, originalArgv[1]!, "mem", secretArg];
  try {
    expect(writeErrorLog(new Error("render failed"), "doctor mem/html-report")).toBe(path);
  } finally {
    process.argv = originalArgv;
  }

  const content = readFileSync(path, "utf-8");
  expect(content).toContain("command: mem");
  expect(content).toContain("context: doctor mem/html-report");
  expect(content).toContain("runtime: bun ");
  expect(content).toContain(`platform: ${process.platform}-${process.arch}`);
  expect(content).toContain(`cwd: ${process.cwd()}`);
  expect(content).toContain("Error: render failed");
  expect(content).not.toContain(secretArg);
});

test("writeErrorLog 保留完整 cause chain", () => {
  const path = join(mkdtempSync(join(tmpdir(), "doctor-error-cause-")), "error.log");
  process.env.DOCTOR_ERROR_LOG = path;

  writeErrorLog(
    new Error("plugin startup failed", { cause: new Error("kubectl stderr detail") }),
    "doctor data/startup",
  );

  const content = readFileSync(path, "utf-8");
  expect(content).toContain("Error: plugin startup failed");
  expect(content).toContain("Caused by:");
  expect(content).toContain("Error: kubectl stderr detail");
});

test("reportError 默认输出人读摘要并把技术详情留在日志", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "doctor-error-summary-")), "error.log");
  process.env.DOCTOR_ERROR_LOG = path;
  process.env.DOCTOR_DEBUG = "0";
  const write = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const { reportError } = await import("../src/app/error-log");
    expect(reportError(new Error("model request failed"), {
      context: "doctor model/inference",
      summary: "fatal",
      plugin: "test@0.0.1",
    })).toBe(path);
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("fatal: model request failed");
    expect(output).toContain("Plugin test@0.0.1；命令 model；阶段 doctor model/inference");
    expect(output).toContain(`技术详情: ${path}`);
    expect(output).not.toContain("[doctor] debug:");
    expect(readFileSync(path, "utf-8")).toContain("plugin: test@0.0.1");
    expect(readFileSync(path, "utf-8")).toContain("Error: model request failed");
  } finally {
    write.mockRestore();
  }
});

test("reportError 在日志不可写时把技术详情回退到 stderr", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-error-fallback-"));
  process.env.DOCTOR_ERROR_LOG = directory;
  const write = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const { reportError } = await import("../src/app/error-log");
    expect(reportError(new Error("render failed"), {
      context: "doctor mem/html-report",
      summary: "fatal",
    })).toBeUndefined();
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("fatal: render failed");
    expect(output).toContain("阶段 doctor mem/html-report");
    expect(output).toContain("无法写入错误日志");
    expect(output).toContain("技术详情:\nError: render failed");
  } finally {
    write.mockRestore();
  }
});

test("DOCTOR_DEBUG 启用时同时把技术详情输出到 stderr", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "doctor-error-debug-")), "error.log");
  process.env.DOCTOR_ERROR_LOG = path;
  process.env.DOCTOR_DEBUG = "1";
  const write = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const { reportError } = await import("../src/app/error-log");
    expect(reportError(new Error("model request failed"), {
      context: "doctor chat/turn",
      summary: "fatal",
    })).toBe(path);
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("技术详情: ");
    expect(output).toContain("[doctor] debug:\nError: model request failed");
  } finally {
    write.mockRestore();
  }
});

test("resolveErrorLogPath 支持显式覆盖", () => {
  const path = join(tmpdir(), "doctor-custom-error.log");
  process.env.DOCTOR_ERROR_LOG = path;
  expect(resolveErrorLogPath()).toBe(path);
});

test("resolveErrorLogPath 默认使用 doctor 执行目录", () => {
  delete process.env.DOCTOR_ERROR_LOG;
  expect(resolveErrorLogPath()).toMatch(
    new RegExp(`^${resolve("doctor-error-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d{8}-\\d{6}\\.log$`),
  );
  expect(resolveErrorLogPath()).toBe(resolveErrorLogPath());
});
