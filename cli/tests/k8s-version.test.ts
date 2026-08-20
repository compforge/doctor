import { expect, test } from "bun:test";
import {
  getKubernetesServerVersion,
  parseKubernetesServerVersion,
} from "../src/infra/k8s/version";
import { inspectKubernetesChannel } from "../src/infra/k8s/access";
import type { ExecResult, Executor } from "../src/infra/k8s/executor";

function result(stdout: string, ok = true): ExecResult {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command: ["kubectl"],
  };
}

test("解析 Kubernetes API Server gitVersion", () => {
  expect(parseKubernetesServerVersion('{"major":"1","minor":"32","gitVersion":"v1.32.3"}'))
    .toBe("v1.32.3");
  expect(parseKubernetesServerVersion("not-json")).toBeUndefined();
});

test("Kubernetes 版本探测失败时安静降级", async () => {
  const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  const executor: Executor = {
    run: async (args, options) => {
      calls.push({ args, timeoutMs: options?.timeoutMs });
      return result("", false);
    },
    exec: async () => result("", false),
  };

  expect(await getKubernetesServerVersion(executor)).toBeUndefined();
  expect(calls).toEqual([{
    args: ["--request-timeout=300ms", "get", "--raw=/version"],
    timeoutMs: 500,
  }]);
});

test("Kubernetes 启动探测复用 Server 版本解析", async () => {
  const responses = [
    result('{"clientVersion":{"gitVersion":"v1.32.2"}}'),
    result('{"gitVersion":"v1.32.3"}'),
  ];
  const executor: Executor = {
    run: async () => responses.shift()!,
    exec: async () => result("", false),
  };

  const fact = await inspectKubernetesChannel(executor);
  expect(fact.available).toBe(true);
  expect(fact.serverVersion).toBe("v1.32.3");
});
