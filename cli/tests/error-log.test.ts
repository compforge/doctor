import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveErrorLogPath, writeErrorLog } from "../src/app/error-log";

const originalErrorLog = process.env.DOCTOR_ERROR_LOG;

afterEach(() => {
  if (originalErrorLog === undefined) delete process.env.DOCTOR_ERROR_LOG;
  else process.env.DOCTOR_ERROR_LOG = originalErrorLog;
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
  expect(content).toContain("Error: render failed");
  expect(content).not.toContain(secretArg);
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
