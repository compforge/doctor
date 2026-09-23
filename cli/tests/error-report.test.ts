import { afterEach, expect, spyOn, test } from "bun:test";
import { reportError } from "../src/app/error-report";
import { withLogger } from "../src/terminal/log";

const originalDebug = process.env.DOCTOR_DEBUG;
const originalArgv = process.argv;
afterEach(() => {
  if (originalDebug === undefined) delete process.env.DOCTOR_DEBUG;
  else process.env.DOCTOR_DEBUG = originalDebug;
  process.argv = originalArgv;
});

function capture(work: () => void): string {
  const write = spyOn(process.stderr, "write").mockImplementation(() => true);
  try { work(); return write.mock.calls.map(([chunk]) => String(chunk)).join(""); }
  finally { write.mockRestore(); }
}

test("error level retains error summary and context without stack or a file path", () => {
  process.env.DOCTOR_DEBUG = "0";
  process.argv = ["bun", "doctor", "model", "secret-argument"];
  const output = capture(() => withLogger("error", () => reportError(
    new Error("model request failed", { cause: new Error("private cause") }),
    { context: "doctor model/inference", summary: "fatal", plugin: "test@0.0.1" },
  )));
  expect(output).toContain("fatal: model request failed");
  expect(output).toContain("Plugin test@0.0.1；命令 model；阶段 doctor model/inference");
  expect(output).not.toContain("private cause");
  expect(output).not.toContain("secret-argument");
  expect(output).not.toContain("技术详情:");
  expect(output).not.toContain("debug:");
});

for (const source of ["environment", "flag"]) test(`explicit ${source} debug prints stack and cause even with error-level logging`, () => {
  process.env.DOCTOR_DEBUG = source === "environment" ? "1" : "0";
  process.argv = ["bun", "doctor", ...(source === "flag" ? ["--debug"] : [])];
  const error = new AggregateError([new Error("child failure")], "outer failure", { cause: new Error("root cause") });
  const output = capture(() => withLogger("error", () => reportError(error, { context: "doctor trace/run", displayMessage: "query failed" })));
  expect(output).toContain("error: query failed");
  expect(output).toContain("debug:");
  expect(output).toContain(error.stack!);
  expect(output).toContain("Caused by:");
  expect(output).toContain("Error: root cause");
  expect(output).toContain("Aggregate error 1:");
  expect(output).toContain("Error: child failure");
});

test("debug handles circular exception causes", () => {
  process.env.DOCTOR_DEBUG = "1";
  const error = new Error("cycle"); error.cause = error;
  expect(capture(() => reportError(error, { context: "doctor runtime/uncaughtException" }))).toContain("[circular error cause]");
});
