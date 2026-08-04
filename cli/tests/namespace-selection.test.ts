import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, Executor } from "../src/infra/k8s/executor";
import { RecentSelections } from "../src/infra/recent";
import {
  matchNamespaceChoices,
  parseNamespaceChoices,
  resolveNamespaceAnswer,
  resolvePodNamespace,
} from "../src/infra/k8s/namespace-selection";

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command: ["kubectl", "get", "namespaces", "-o", "json"],
    ...overrides,
  };
}

class NamespaceExecutor implements Executor {
  readonly calls: string[][] = [];

  constructor(private readonly response: ExecResult) {}

  async run(command: string[]): Promise<ExecResult> {
    this.calls.push(command);
    return this.response;
  }

  async exec(): Promise<ExecResult> {
    throw new Error("unexpected exec");
  }
}

const NAMESPACES = JSON.stringify({
  items: [
    { metadata: { name: "z-terminating" }, status: { phase: "Terminating" } },
    { metadata: { name: "default" }, status: { phase: "Active" } },
    { metadata: { name: "app-system" }, status: { phase: "Active" } },
  ],
});

describe("Namespace 选择", () => {
  test("解析时 Active 优先，并支持精确名称与关键词", () => {
    const choices = parseNamespaceChoices(NAMESPACES);
    expect(choices.map((choice) => choice.name)).toEqual(["app-system", "default", "z-terminating"]);
    expect(matchNamespaceChoices(choices, "DEFAULT").map((choice) => choice.name)).toEqual(["default"]);
    expect(matchNamespaceChoices(choices, "system").map((choice) => choice.name)).toEqual(["app-system"]);
  });

  test("回车使用默认 namespace，序号只对已展示候选生效", () => {
    const choices = parseNamespaceChoices(NAMESPACES);
    expect(resolveNamespaceAnswer(choices, "", "default")).toEqual({
      kind: "selected",
      namespace: "default",
    });
    expect(resolveNamespaceAnswer(choices, "2", "default", choices)).toEqual({
      kind: "selected",
      namespace: "default",
    });
    expect(resolveNamespaceAnswer(choices, "4", "default", choices)).toEqual({
      kind: "invalid-number",
    });
    expect(resolveNamespaceAnswer([], "customer-system", "default")).toEqual({
      kind: "selected",
      namespace: "customer-system",
    });
    expect(resolveNamespaceAnswer([], "2", "default")).toEqual({ kind: "invalid-number" });
  });

  test("显式 flag/profile 与非交互场景不查 Namespace 列表", async () => {
    const executor = new NamespaceExecutor(result({ stdout: NAMESPACES }));
    expect(await resolvePodNamespace({
      resolved: { namespace: "dev", source: "flag" },
      executor,
      interactive: true,
    })).toEqual({ namespace: "dev", source: "flag" });
    expect(await resolvePodNamespace({
      resolved: { namespace: "default", source: "default" },
      executor,
      interactive: false,
    })).toEqual({ namespace: "default", source: "default" });
    expect(executor.calls).toEqual([]);
  });

  test("交互场景列出 Namespace 并返回 prompt 来源", async () => {
    const executor = new NamespaceExecutor(result({ stdout: NAMESPACES }));
    const selected = await resolvePodNamespace({
      resolved: { namespace: "default", source: "default" },
      executor,
      interactive: true,
      prompt: async (choices, defaultNamespace) => {
        expect(choices.map((choice) => choice.name)).toEqual(["app-system", "default", "z-terminating"]);
        expect(defaultNamespace).toBe("default");
        return "app-system";
      },
    });
    expect(selected).toEqual({ namespace: "app-system", source: "prompt" });
    expect(executor.calls).toEqual([["get", "namespaces", "-o", "json"]]);
  });

  test("同为 Active 时近期使用的 Namespace 排在前面", async () => {
    const executor = new NamespaceExecutor(result({ stdout: NAMESPACES }));
    const recent = new RecentSelections(
      join(mkdtempSync(join(tmpdir(), "doctor-namespace-recent-")), "recent.json"),
    );
    const scope = { kubeconfig: "/tmp/kubeconfig", context: "dev" };
    recent.recordKubernetesTarget(scope, {
      namespace: "default",
      pod: "frontend-0",
    });

    await resolvePodNamespace({
      resolved: { namespace: "app-system", source: "default" },
      kubeconfig: scope.kubeconfig,
      context: scope.context,
      executor,
      interactive: true,
      recent,
      prompt: async (choices) => {
        expect(choices.map((choice) => choice.name)).toEqual([
          "default",
          "app-system",
          "z-terminating",
        ]);
        return "default";
      },
    });
  });

  test("无权列 Namespace 时仍允许手输，q 取消传递 undefined", async () => {
    const executor = new NamespaceExecutor(result({
      ok: false,
      exitCode: 1,
      stderr: "namespaces is forbidden",
    }));
    expect(await resolvePodNamespace({
      resolved: { namespace: "default", source: "default" },
      executor,
      interactive: true,
      prompt: async (choices) => {
        expect(choices).toEqual([]);
        return "customer-system";
      },
    })).toEqual({ namespace: "customer-system", source: "prompt" });
    expect(await resolvePodNamespace({
      resolved: { namespace: "default", source: "default" },
      executor,
      interactive: true,
      prompt: async () => undefined,
    })).toBeUndefined();
  });
});
