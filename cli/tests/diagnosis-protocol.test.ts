import { describe, expect, test } from "bun:test";
import { runDiagnosis } from "../src/collect/engine";
import { runInspects } from "../src/collect/inspect-engine";
import { runProbes } from "../src/collect/probe-engine";
import type { Inspect } from "../src/collect/inspection";
import {
  PROBE_RUNNABLE,
  probeUnavailable,
  probeUnnecessary,
  type Detector,
  type EvidenceBuilder,
  type FindingMeta,
  type Probe,
} from "../src/collect/protocol";

test("runDiagnosis 串联 facts、probe、evidence builder 和 detectors", async () => {
  type Observation = { id: string; kind: "number"; value: number };
  type Facts = { limit: number };
  type Evidence = { observations: readonly Observation[]; facts: Facts; total: number };
  type TotalFinding = FindingMeta<"total"> & { total: number; overLimit: boolean };

  const probe: Probe<Observation, Facts, {}> = {
    id: "numbers",
    evaluate: () => PROBE_RUNNABLE,
    run: async () => [
      { id: "number:1", kind: "number", value: 2 },
      { id: "number:2", kind: "number", value: 3 },
    ],
  };
  const buildEvidence: EvidenceBuilder<Observation, Facts, Evidence> = (observations, facts) => ({
    observations,
    facts,
    total: observations.reduce((sum, observation) => sum + observation.value, 0),
  });
  // detector 同时读 observations 与 facts，并分别引用两种来源
  const detector: Detector<Evidence, TotalFinding> = (evidence) => [{
    id: "total",
    kind: "total",
    severity: "info",
    confidence: "high",
    evidence: [
      ...evidence.observations.map((observation) => ({
        observationId: observation.id,
        role: "supporting" as const,
      })),
      { factPath: "limit", role: "context" as const },
    ],
    total: evidence.total,
    overLimit: evidence.total > evidence.facts.limit,
  }];

  await expect(runDiagnosis({
    ctx: undefined,
    facts: { limit: 4 },
    config: {},
    probes: [probe],
    log: () => {},
    buildEvidence,
    detectors: [detector],
    buildCoverage: () => [{
      goal: "sum",
      status: "sufficient",
      missingEvidence: [],
    }],
  })).resolves.toEqual({
    evidence: {
      observations: [
        { id: "number:1", kind: "number", value: 2 },
        { id: "number:2", kind: "number", value: 3 },
      ],
      facts: { limit: 4 },
      total: 5,
    },
    findings: [{
      id: "total",
      kind: "total",
      severity: "info",
      confidence: "high",
      evidence: [
        { observationId: "number:1", role: "supporting" },
        { observationId: "number:2", role: "supporting" },
        { factPath: "limit", role: "context" },
      ],
      total: 5,
      overLimit: true,
    }],
    coverage: [{ goal: "sum", status: "sufficient", missingEvidence: [] }],
  });
});

test("facts 先于 probe：probe 跑不跑可以由 facts 决定，反过来会成环", async () => {
  type Observation = { id: string; kind: "n"; value: number };
  type Facts = { probeAllowed: boolean };
  type Evidence = { observations: readonly Observation[]; facts: Facts };

  let probeRan = false;
  const probe: Probe<Observation, Facts, {}> = {
    id: "n",
    evaluate: (facts) => facts.probeAllowed
      ? PROBE_RUNNABLE
      : probeUnavailable("探针未获准执行"),
    run: async () => {
      probeRan = true;
      return [{ id: "n:1", kind: "n", value: 1 }];
    },
  };
  const buildEvidence: EvidenceBuilder<Observation, Facts, Evidence> = (observations, facts) => ({
    observations,
    facts,
  });

  const facts: Facts = { probeAllowed: false };
  const diagnosis = await runDiagnosis({
    ctx: undefined,
    facts,
    config: {},
    probes: [probe],
    log: () => {},
    buildEvidence,
    detectors: [],
    buildCoverage: (e) => [{
      goal: "n",
      // coverage 能说清"为什么没证据"——这正是 facts 进 Evidence 的理由
      status: e.observations.length ? "sufficient" : "insufficient",
      missingEvidence: e.facts.probeAllowed ? [] : ["探针未获准执行"],
    }],
  });

  expect(probeRan).toBe(false);
  expect(diagnosis.coverage[0]).toEqual({
    goal: "n",
    status: "insufficient",
    missingEvidence: ["探针未获准执行"],
  });
});

describe("runInspects 调度", () => {
  type Facts = {
    target: { pod: string };
    canExec: boolean;
    runtime: { python3: boolean; paths: string[] };
  };
  type Ctx = { pod: string };

  test("按依赖确定性执行，并把多个 Fact 合并为冻结的初始快照", async () => {
    const trace: string[] = [];
    const target: Inspect<Facts, Ctx> = {
      id: "target",
      run: async (ctx) => {
        trace.push("target");
        return { target: { pod: ctx.pod } };
      },
    };
    const capabilities: Inspect<Facts, Ctx> = {
      id: "capabilities",
      dependsOn: ["target"],
      run: async (_ctx, facts) => {
        trace.push(`capabilities:${facts.target?.pod}`);
        return {
          canExec: true,
          runtime: { python3: true, paths: ["/proc"] },
        };
      },
    };

    const facts = await runInspects([capabilities, target], { pod: "app-0" });

    expect(trace).toEqual(["target", "capabilities:app-0"]);
    expect(facts).toEqual({
      target: { pod: "app-0" },
      canExec: true,
      runtime: { python3: true, paths: ["/proc"] },
    });
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.runtime)).toBe(true);
    expect(Object.isFrozen(facts.runtime.paths)).toBe(true);
  });

  test("记录每个 Inspect 的开始、完成与 Fact 数量", async () => {
    const logs: string[] = [];
    await runInspects<Facts, Ctx>([
      { id: "empty", run: async () => ({}) },
      { id: "target", run: async (ctx) => ({ target: { pod: ctx.pod } }) },
    ], { pod: "app-0" }, (line) => logs.push(line));
    expect(logs).toEqual([
      "[collect] 执行 Inspect：empty…",
      "[collect] Inspect 完成：empty（0 个 Fact）",
      "[collect] 执行 Inspect：target…",
      "[collect] Inspect 完成：target（1 个 Fact）",
    ]);
  });

  test("拒绝重复 fact，避免后执行的 Inspect 覆盖初始现实", async () => {
    await expect(runInspects<Facts, Ctx>([
      { id: "first", run: async () => ({ canExec: true }) },
      { id: "second", run: async () => ({ canExec: false }) },
    ], { pod: "app-0" })).rejects.toThrow("inspect second produced duplicate fact: canExec");
  });

  test("执行前拒绝重复 id、未知依赖和重复依赖", async () => {
    await expect(runInspects<Facts, Ctx>([
      { id: "same", run: async () => ({}) },
      { id: "same", run: async () => ({}) },
    ], { pod: "app-0" })).rejects.toThrow("duplicate inspect id: same");
    await expect(runInspects<Facts, Ctx>([
      { id: "consumer", dependsOn: ["missing"], run: async () => ({}) },
    ], { pod: "app-0" })).rejects.toThrow(
      "inspect consumer depends on unknown inspect: missing",
    );
    await expect(runInspects<Facts, Ctx>([
      { id: "source", run: async () => ({}) },
      { id: "consumer", dependsOn: ["source", "source"], run: async () => ({}) },
    ], { pod: "app-0" })).rejects.toThrow(
      "inspect consumer declares duplicate dependency: source",
    );
  });

  test("依赖成环时报错", async () => {
    await expect(runInspects<Facts, Ctx>([
      { id: "a", dependsOn: ["b"], run: async () => ({}) },
      { id: "b", dependsOn: ["a"], run: async () => ({}) },
    ], { pod: "app-0" })).rejects.toThrow("inspect dependency cycle: a, b");
  });
});

/**
 * targetAccess 的调度契约。
 *
 * "py-spy 必须最后"不是数据依赖，是"我会毁掉你正在读的现场"（它的 workload rollout
 * 会换掉 Pod）。用 dependsOn:[其它所有] 表达的话，以后加 probe 忘了加就会静默毁现场；
 * 用 targetAccess 表达，新 probe 默认 read 就自动安全。
 */
describe("runProbes 调度", () => {
  type O = { id: string; kind: "x"; from: string };
  const trace: string[] = [];
  const probe = (id: string, targetAccess?: "read" | "destroy"): Probe<O, {}, {}> => ({
    id,
    targetAccess,
    evaluate: () => PROBE_RUNNABLE,
    run: async () => {
      trace.push(id);
      return [{ id, kind: "x", from: id }];
    },
  });

  test("destroy 排在所有 read 之后——即使它写在数组中间", async () => {
    trace.length = 0;
    const observations = await runProbes(
      [probe("a"), probe("destroyer", "destroy"), probe("b"), probe("c")],
      undefined,
      {},
      {},
    );
    expect(trace).toEqual(["a", "b", "c", "destroyer"]);
    // observations 顺序跟执行顺序一致
    expect(observations.map((o) => o.from)).toEqual(["a", "b", "c", "destroyer"]);
  });

  test("不写 targetAccess 就是 read——新 probe 默认安全，忘不了", async () => {
    trace.length = 0;
    await runProbes(
      [probe("destroyer", "destroy"), probe("忘了写的新 probe")],
      undefined,
      {},
      {},
    );
    expect(trace).toEqual(["忘了写的新 probe", "destroyer"]);
  });

  test("read 之间按数组顺序串行", async () => {
    trace.length = 0;
    await runProbes([probe("c"), probe("a"), probe("b")], undefined, {}, {});
    expect(trace).toEqual(["c", "a", "b"]);
  });

  test("产出零条 observation 是正常的，不影响其它 probe", async () => {
    const observations = await runProbes<O, {}, {}>(
      [
        { id: "empty", evaluate: () => PROBE_RUNNABLE, run: async () => [] },
        probe("normal"),
      ],
      undefined,
      {},
      {},
    );
    expect(observations.map((o) => o.from)).toEqual(["normal"]);
  });

  test("facts 传给每个 probe——probe 靠它决定跑不跑", async () => {
    const seen: string[] = [];
    await runProbes<O, { mode: string }, {}>(
      [{
        id: "p",
        evaluate: (facts) => { seen.push(facts.mode); return PROBE_RUNNABLE; },
        run: async () => [],
      }],
      undefined,
      { mode: "observe" },
      {},
    );
    expect(seen).toEqual(["observe"]);
  });

  test("同一份 config 传给 evaluate 和 run，具体 probe 自行决定是否读取", async () => {
    const config = { mode: "overhead" };
    let evaluatedConfig: typeof config | undefined;
    let runConfig: typeof config | undefined;
    await runProbes<O, {}, typeof config>([{
      id: "config-aware",
      evaluate: (_facts, received) => {
        evaluatedConfig = received;
        return PROBE_RUNNABLE;
      },
      run: async (_ctx, _facts, received) => {
        runConfig = received;
        return [];
      },
    }], undefined, {}, config);

    expect(evaluatedConfig).toBe(config);
    expect(runConfig).toBe(config);
  });

  test("dependsOn 决定拓扑顺序，并只注入直接依赖的 progress", async () => {
    const seen: string[] = [];
    const consumer: Probe<O, {}, {}> = {
      id: "consumer",
      dependsOn: ["source"],
      evaluate: () => PROBE_RUNNABLE,
      run: async (_ctx, _facts, _config, progress) => {
        trace.push("consumer");
        seen.push(...progress.flatMap((result) => result.observations.map((observation) => (
          `${result.probeId}:${observation.from}`
        ))));
        return [];
      },
    };
    trace.length = 0;
    await runProbes([consumer, probe("independent"), probe("source")], undefined, {}, {});
    expect(trace).toEqual(["independent", "source", "consumer"]);
    expect(seen).toEqual(["source:source"]);
  });

  test("上游产出零条 observation 时仍提供一条 progress", async () => {
    let received: unknown;
    const consumer: Probe<O, {}, {}> = {
      id: "consumer",
      dependsOn: ["empty"],
      evaluate: () => PROBE_RUNNABLE,
      run: async (_ctx, _facts, _config, progress) => {
        received = progress;
        return [];
      },
    };
    await runProbes([{
      id: "empty",
      evaluate: () => PROBE_RUNNABLE,
      run: async () => [],
    }, consumer], undefined, {}, {});
    expect(received).toEqual([{ probeId: "empty", observations: [] }]);
  });

  test("记录每个 probe 的开始、完成与 observation 数量", async () => {
    const logs: string[] = [];
    await runProbes(
      [probe("first"), {
        id: "empty",
        evaluate: () => PROBE_RUNNABLE,
        run: async () => [],
      }],
      undefined,
      {},
      {},
      (line) => logs.push(line),
    );
    expect(logs).toEqual([
      "[collect] 执行 Probe：first…",
      "[collect] Probe 完成：first（1 条 Observation）",
      "[collect] 执行 Probe：empty…",
      "[collect] Probe 完成：empty（0 条 Observation）",
    ]);
  });

  test("evaluate 不可用时不执行 run，并由 engine 统一记录原因", async () => {
    const logs: string[] = [];
    let ran = false;
    let recorded = "";
    const observations = await runProbes<O, {}, {}, { name: string }>([{
      id: "missing-runtime",
      evaluate: () => probeUnavailable("目标容器没有 python3"),
      onUnavailable: (_ctx, reason) => { recorded = reason; },
      run: async () => {
        ran = true;
        return [];
      },
    }], { name: "ctx" }, {}, {}, (line) => logs.push(line));

    expect(ran).toBe(false);
    expect(recorded).toBe("目标容器没有 python3");
    expect(observations).toEqual([]);
    expect(logs).toEqual([
      "[collect] Probe 不可用：missing-runtime（目标容器没有 python3）",
    ]);
  });

  test("evaluate 判定无需执行时使用独立状态和日志", async () => {
    const logs: string[] = [];
    let ran = false;
    let recorded = "";
    await runProbes<O, {}, {}, { name: string }>([{
      id: "extended-window",
      evaluate: () => probeUnnecessary("短窗口证据已经充分"),
      onUnnecessary: (_ctx, reason) => { recorded = reason; },
      run: async () => {
        ran = true;
        return [];
      },
    }], { name: "ctx" }, {}, {}, (line) => logs.push(line));

    expect(ran).toBe(false);
    expect(recorded).toBe("短窗口证据已经充分");
    expect(logs).toEqual([
      "[collect] Probe 无需执行：extended-window（短窗口证据已经充分）",
    ]);
  });

  test("未知依赖在执行前报错", async () => {
    await expect(runProbes<O, {}, {}>([
      {
        id: "consumer",
        dependsOn: ["missing"],
        evaluate: () => PROBE_RUNNABLE,
        run: async () => [],
      },
    ], undefined, {}, {})).rejects.toThrow("probe consumer depends on unknown probe: missing");
  });

  test("依赖成环时报错", async () => {
    await expect(runProbes<O, {}, {}>([
      { id: "a", dependsOn: ["b"], evaluate: () => PROBE_RUNNABLE, run: async () => [] },
      { id: "b", dependsOn: ["a"], evaluate: () => PROBE_RUNNABLE, run: async () => [] },
    ], undefined, {}, {})).rejects.toThrow("probe dependency cycle: a, b");
  });

  test("read 不能依赖 destroy，避免与安全调度约束冲突", async () => {
    await expect(runProbes<O, {}, {}>([
      {
        id: "reader",
        dependsOn: ["destroyer"],
        evaluate: () => PROBE_RUNNABLE,
        run: async () => [],
      },
      {
        id: "destroyer",
        targetAccess: "destroy",
        evaluate: () => PROBE_RUNNABLE,
        run: async () => [],
      },
    ], undefined, {}, {})).rejects.toThrow(
      "read probe reader cannot depend on destroy probe: destroyer",
    );
  });
});
