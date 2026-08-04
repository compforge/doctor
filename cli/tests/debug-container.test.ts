import { describe, expect, test } from "bun:test";
import { debugEngine } from "../src/infra/target/debug";

function podJson(): string {
  return JSON.stringify({
    spec: {
      ephemeralContainers: [
        {
          name: "doctor-debug-ready",
          image: "registry/team/doctor-debug:1",
          targetContainerName: "app",
          securityContext: { capabilities: { add: ["SYS_PTRACE"] } },
        },
        {
          name: "doctor-debug-other",
          image: "registry/team/doctor-debug:1",
          targetContainerName: "sidecar",
          securityContext: { capabilities: { add: ["SYS_PTRACE"] } },
        },
        {
          name: "doctor-debug-newest",
          image: "registry/team/doctor-debug:2",
          targetContainerName: "app",
          securityContext: { capabilities: { add: ["SYS_PTRACE"] } },
        },
      ],
    },
    status: {
      ephemeralContainerStatuses: [
        { name: "doctor-debug-ready", state: { running: {} } },
        { name: "doctor-debug-other", state: { running: {} } },
        { name: "doctor-debug-newest", state: { running: {} } },
      ],
    },
  });
}

describe("DebugEnvironment Fact", () => {
  test("只保留兼容候选，并自动选择最后加入的一个", () => {
    const facts = debugEngine.inspectEnvironments(podJson(), "app");
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      kind: "ephemeral-container",
      executionContainer: "doctor-debug-ready",
      targetContainer: "app",
      state: "running",
      compatible: true,
    });
    expect(debugEngine.resolveEnvironment(facts)).toEqual({ ok: true, value: facts[1] });
  });

  test("没有候选时要求先独立 deploy，不返回待创建 operation", () => {
    const resolved = debugEngine.resolveEnvironment([]);
    expect(resolved).toMatchObject({ ok: false });
    if (!resolved.ok) expect(resolved.reason).toContain("doctor debug");
  });

  test("NET_RAW-only environment 只满足网络诊断，不会被内存诊断复用", () => {
    const raw = JSON.parse(podJson());
    raw.spec.ephemeralContainers.push({
      name: "doctor-debug-network",
      image: "registry/team/doctor-debug:2",
      targetContainerName: "app",
      securityContext: { capabilities: { add: ["NET_RAW"] } },
    });
    raw.status.ephemeralContainerStatuses.push({
      name: "doctor-debug-network",
      state: { running: {} },
    });
    const facts = debugEngine.inspectEnvironments(JSON.stringify(raw), "app");

    expect(debugEngine.resolveEnvironment(facts, ["NET_RAW"])).toEqual({
      ok: true,
      value: facts[2],
    });
    expect(debugEngine.resolveEnvironment(
      facts.filter((fact) => fact.executionContainer === "doctor-debug-network"),
    )).toMatchObject({ ok: false });
  });
});
