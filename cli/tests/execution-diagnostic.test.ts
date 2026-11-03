import { expect, test } from "bun:test";
import { ToolboxError } from "@compforge/harness-toolbox/errors";
import { executionDiagnostic } from "../src/command/diagnostic";
import { inCommandScope, onCommandDispose } from "../src/command/execution-scope";
import { withDeadline } from "../src/command/deadline";

/** @case Cause chains retain transport evidence while credentials are absent from archive JSON. */
test("diagnostics retain bounded context and sanitize every cause", () => {
  const cause = Object.assign(new Error("connect https://alice:private@search.test:9200/?token=signed\nAuthorization: Bearer hidden\npassword=credential"), { code: "ECONNRESET" });
  const error = new ToolboxError("OpenSearch request failed", { kind: "connection_failed", code: 502, cause });
  const saved = executionDiagnostic(error, { phase: "query", target: "search", startedAt: Date.now() - 10 });
  expect(saved).toMatchObject({ phase: "query", target: "search", kind: "connection_failed", code: 502,
    causes: [{ code: "ECONNRESET" }] });
  expect(saved.durationMs).toBeGreaterThanOrEqual(10);
  expect(saved.causes[0]!.message).toContain("search.test:9200");
  for (const secret of ["alice", "private", "signed", "hidden", "credential"]) expect(JSON.stringify(saved)).not.toContain(secret);
  const cycle = new Error("cycle"); cycle.cause = cycle;
  expect(executionDiagnostic(cycle, { phase: "test", target: "test", startedAt: 0 }).causes).toEqual([]);
});

test("cleanup budget starts remaining disposers and reports a hung disposer", async () => {
  const order: string[] = [];
  const diagnostics: ReturnType<typeof executionDiagnostic>[] = [];
  await expect(inCommandScope(new AbortController().signal, async () => {
    onCommandDispose(() => { order.push("earlier"); });
    onCommandDispose(() => { order.push("hung"); return new Promise<void>(() => {}); });
  }, undefined, { cleanupTimeoutMs: 10, diagnostics })).rejects.toThrow("cleanup failed");
  expect(order).toEqual(["hung", "earlier"]);
  expect(diagnostics).toMatchObject([{ phase: "cleanup", kind: "timeout" }]);
});

test("deadline aborts the I/O owner and does not cancel the parent", async () => {
  const parent = new AbortController();
  let interrupted = false;
  await expect(withDeadline(parent.signal, 10, async signal => new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => { interrupted = true; reject(signal.reason); }, { once: true });
  }))).rejects.toThrow("timed out");
  expect(interrupted).toBe(true);
  expect(parent.signal.aborted).toBe(false);
});
