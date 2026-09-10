import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConcurrencyPool } from "@compforge/doctor-toolkit/concurrency";
import { SharedPodLogCaptures, type PodLogSourceScope } from "../src/infra/k8s/shared-pod-log";
import type { KubernetesPodLogAccess, PodLogRequest, PodLogResult } from "../src/infra/k8s/pod-log";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const scope: PodLogSourceScope = { namespace: "test", instance: "pod-uid/container-id" };
const request: PodLogRequest = { pod: "api", container: "app", sinceTime: "2026-09-10T00:00:00Z" };
function access(collect: KubernetesPodLogAccess["collectPodLogs"]): KubernetesPodLogAccess {
  return { collectPodLogs: collect, clientVersion: async () => { throw new Error("unused"); },
    listServicePods: async () => { throw new Error("unused"); } };
}
function result(bytesRead = 10): PodLogResult {
  return { ok: true, exitCode: 0, command: [], durationMs: 1, stdout: "", stderr: "", timedOut: false,
    captureStatus: "complete", bytesRead, attempts: 1 };
}

test("late and completed consumers replay every line in order, get early hits and keep partial raw after root disposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-shared-log-test-"));
  const session = new SharedPodLogCaptures(new ConcurrencyPool(1), new AbortController().signal);
  await session.initialize();
  const started = deferred(), release = deferred(), hitA = deferred(), hitB = deferred();
  const lines = ["trace-a 开始", ...Array.from({ length: 8000 }, (_, i) => `trace-b 第 ${i} 行 多字节日志`), "trace-a 结束"];
  let calls = 0;
  const transport = access(async input => {
    calls++;
    expect(input.collectStdout).toBeFalse();
    input.onLine!(lines[0]!);
    started.resolve();
    await release.promise;
    for (const line of lines.slice(1)) input.onLine!(line);
    return { ...result(1234), ok: false, captureStatus: "partial", reason: "idle_timeout" };
  });
  const a: string[] = [], b: string[] = [], c: string[] = [];
  try {
    const first = session.capture(transport, scope, { ...request, rawFilePath: join(root, "a.log"),
      onLine: line => { a.push(line); hitA.resolve(); } });
    await started.promise;
    await hitA.promise;
    const second = session.capture(transport, scope, { ...request, rawFilePath: join(root, "b.log"),
      onLine: line => { b.push(line); hitB.resolve(); } });
    // The late consumer sees the buffered first line before the HTTP stream finishes.
    await hitB.promise;
    expect(b).toEqual([lines[0]!]);
    release.resolve();
    const [one, two] = await Promise.all([first, second]);
    const three = await session.capture(transport, scope, { ...request, rawFilePath: join(root, "c.log"), onLine: line => c.push(line) });
    expect(calls).toBe(1);
    expect([a, b, c]).toEqual([lines, lines, lines]);
    expect([one?.bytesRead, two?.bytesRead, three?.bytesRead]).toEqual([1234, 0, 0]);
    expect([one?.captureStatus, two?.captureStatus, three?.captureStatus]).toEqual(["partial", "partial", "partial"]);
    expect(two?.reused).toBeTrue();
    await session.dispose();
    for (const id of ["a", "b", "c"]) expect(readFileSync(join(root, `${id}.log`), "utf8")).toBe(lines.join("\n") + "\n");
  } finally { release.resolve(); await session.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("network byte budget spans independent captures and exhausted budget does not block replay", async () => {
  const session = new SharedPodLogCaptures(new ConcurrencyPool(2), new AbortController().signal,
    { concurrency: 2, maxBytesPerCapture: 8, maxTotalBytes: 10 });
  await session.initialize();
  const limits: number[] = [];
  const transport = access(async input => { limits.push(input.limitBytes!); input.onLine!(input.pod); return result(input.limitBytes!); });
  try {
    const captures = await Promise.all(["a", "b", "c"].map(pod => session.capture(transport, scope, { ...request, pod })));
    expect(limits).toEqual([8, 2]);
    expect(captures.map(item => item?.captureStatus)).toEqual(["complete", "complete", "unavailable"]);
    expect(captures[2]?.reason).toBe("total_byte_budget");
    expect(await session.capture(transport, scope, { ...request, pod: "a" })).toMatchObject({ reused: true, bytesRead: 0, captureStatus: "complete" });
    expect(limits).toEqual([8, 2]);
  } finally { await session.dispose(); }
});

test("source identity isolates targets, instances, windows and current/previous; relative or unidentified requests never reuse", async () => {
  const session = new SharedPodLogCaptures(new ConcurrencyPool(2), new AbortController().signal);
  await session.initialize();
  let calls = 0;
  const transport = access(async input => { calls++; input.onLine!("line"); return result(); });
  try {
    await session.capture(transport, scope, request);
    const equivalent = await session.capture(transport, scope, { ...request, sinceTime: "2026-09-10T08:00:00+08:00" });
    expect(equivalent?.reused).toBeTrue();
    const variants: [PodLogSourceScope, PodLogRequest][] = [
      [{ ...scope, namespace: "other" }, request], [{ ...scope, kubeconfig: "/another" }, request],
      [{ ...scope, instance: "replacement-pod/container-id" }, request],
      [{ ...scope, instance: "pod-uid/restarted-container" }, request],
      [scope, { ...request, sinceTime: "2026-09-10T00:00:00.000000001Z" }],
      [scope, { ...request, untilTime: "2026-09-10T00:01:00Z" }],
      [scope, { ...request, previous: true }], [scope, { ...request, tail: 1 }],
      [{ namespace: "test" }, request], [{ namespace: "test" }, request],
      [scope, { ...request, sinceTime: undefined, since: "1h" }], [scope, { ...request, sinceTime: undefined, since: "1h" }],
    ];
    for (const [target, input] of variants) expect((await session.capture(transport, target, input))?.reused).toBeFalse();
    expect(calls).toBe(variants.length + 1);
  } finally { await session.dispose(); }
});

test("cancellation drains the active shared source and its readers without starting queued sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-shared-log-cancel-"));
  const controller = new AbortController();
  const session = new SharedPodLogCaptures(new ConcurrencyPool(1), controller.signal);
  await session.initialize();
  const release = deferred(), started = deferred();
  const pods: string[] = [];
  const transport = access(async input => {
    pods.push(input.pod); input.onLine!("partial trace-a"); started.resolve(); await release.promise;
    return { ...result(), ok: false, captureStatus: "partial" };
  });
  try {
    const first = session.capture(transport, scope, { ...request, rawFilePath: join(root, "a.log") });
    await started.promise;
    const sibling = session.capture(transport, scope, { ...request, rawFilePath: join(root, "b.log") });
    const queued = session.capture(transport, scope, { ...request, pod: "queued" });
    controller.abort(); release.resolve();
    const captures = await Promise.all([first, sibling, queued]);
    expect(pods).toEqual(["api"]);
    expect(captures.map(item => item?.captureStatus)).toEqual(["partial", "partial", undefined]);
    await session.dispose();
    expect(readFileSync(join(root, "b.log"), "utf8")).toBe("partial trace-a\n");
  } finally { release.resolve(); await session.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("reserved bytes delay another capture until unused capacity is returned", async () => {
  const session = new SharedPodLogCaptures(new ConcurrencyPool(2), new AbortController().signal,
    { concurrency: 2, maxBytesPerCapture: 8, maxTotalBytes: 8 });
  await session.initialize();
  const release = deferred(), started = deferred();
  const pods: string[] = [], limits: number[] = [];
  const transport = access(async input => {
    pods.push(input.pod); limits.push(input.limitBytes!);
    if (input.pod === "first") { started.resolve(); await release.promise; }
    return result(2);
  });
  try {
    const first = session.capture(transport, scope, { ...request, pod: "first" });
    await started.promise;
    const second = session.capture(transport, scope, { ...request, pod: "second" });
    await Bun.sleep(1);
    expect(pods).toEqual(["first"]);
    release.resolve();
    expect((await Promise.all([first, second])).map(item => item?.captureStatus)).toEqual(["complete", "complete"]);
    expect(limits).toEqual([8, 6]);
  } finally { release.resolve(); await session.dispose(); }
});
