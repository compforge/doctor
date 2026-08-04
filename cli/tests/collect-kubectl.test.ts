import { describe, expect, test } from "bun:test";
import { buildExecArgs, buildKubectlArgs, runArgv } from "../src/infra/k8s/executor";

describe("buildKubectlArgs", () => {
  test("minimal", () => {
    expect(buildKubectlArgs({ namespace: "ns1" }, ["get", "pods"])).toEqual([
      "kubectl",
      "-n",
      "ns1",
      "get",
      "pods",
    ]);
  });

  test("kubeconfig + context", () => {
    expect(buildKubectlArgs({ namespace: "ns1", kubeconfig: "/k/c", context: "dev" }, ["get", "pods"])).toEqual([
      "kubectl",
      "--kubeconfig",
      "/k/c",
      "--context",
      "dev",
      "-n",
      "ns1",
      "get",
      "pods",
    ]);
  });

  test("参数保持数组形态，不做 shell 拼接（注入面）", () => {
    const args = buildKubectlArgs({ namespace: "ns1" }, ["get", "pod", "a;rm -rf /"]);
    expect(args).toContain("a;rm -rf /"); // 作为单个 argv 元素原样传递
  });
});

describe("buildExecArgs", () => {
  test("interactive with container", () => {
    expect(
      buildExecArgs({ namespace: "ns1" }, { pod: "p1", container: "app" }, ["python3", "-", "procscan"], true),
    ).toEqual(["kubectl", "-n", "ns1", "exec", "-i", "p1", "-c", "app", "--", "python3", "-", "procscan"]);
  });

  test("non-interactive without container", () => {
    expect(buildExecArgs({ namespace: "ns1" }, { pod: "p1" }, ["sh", "-c", "echo hi"], false)).toEqual([
      "kubectl",
      "-n",
      "ns1",
      "exec",
      "p1",
      "--",
      "sh",
      "-c",
      "echo hi",
    ]);
  });
});

describe("runArgv", () => {
  test("captures stdout/stderr/exit code", async () => {
    const res = await runArgv(["sh", "-c", "echo out; echo err 1>&2; exit 3"]);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
    expect(res.stdout.trim()).toBe("out");
    expect(res.stderr.trim()).toBe("err");
  });

  test("stdin is delivered", async () => {
    const res = await runArgv(["sh", "-c", "cat"], { stdin: "hello-probe" });
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("hello-probe");
  });

  test("stdout callback receives progress while preserving captured output", async () => {
    const chunks: string[] = [];
    const res = await runArgv(["sh", "-c", "printf first; sleep 0.05; printf second"], {
      onStdout: (chunk) => chunks.push(chunk),
    });
    expect(res.ok).toBe(true);
    expect(chunks.join("")).toBe("firstsecond");
    expect(res.stdout).toBe("firstsecond");
  });

  test("raw stdout callback can stream bytes without retaining a second in-memory copy", async () => {
    const chunks: Uint8Array[] = [];
    const res = await runArgv(["sh", "-c", "printf first; printf second"], {
      collectStdout: false,
      onStdoutBytes: (chunk) => chunks.push(chunk.slice()),
    });
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("");
    expect(Buffer.concat(chunks).toString("utf-8")).toBe("firstsecond");
  });

  test("stderr callback receives progress while preserving captured output", async () => {
    const chunks: string[] = [];
    const res = await runArgv(["sh", "-c", "printf first >&2; sleep 0.05; printf second >&2"], {
      onStderr: (chunk) => chunks.push(chunk),
    });
    expect(res.ok).toBe(true);
    expect(chunks.join("")).toBe("firstsecond");
    expect(res.stderr).toBe("firstsecond");
  });

  test("timeout kills process", async () => {
    const res = await runArgv(["sleep", "5"], { timeoutMs: 150 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
  });

  test("AbortSignal kills process", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const res = await runArgv(["sh", "-c", "sleep 10"], {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("[aborted]");
  });

  test("missing binary does not throw", async () => {
    const res = await runArgv(["doctor-definitely-not-exists-xyz"]);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBeNull();
  });
});
