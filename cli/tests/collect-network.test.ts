import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  collectNetwork,
  findNetworkScenarioFiles,
  formatNetworkCaptureStatus,
  formatNetworkCaptureScope,
  formatNetworkDebugRecommendation,
  formatNetworkFailureSummary,
  inspectNetworkTopology,
  isNetworkDebugPrerequisiteFailure,
  NETWORK_DEFAULTS,
  resolveNetworkRequest,
  resolveNetworkScenarioFile,
  resolveNetworkServiceScope,
  type NetworkCollectDependencies,
} from "../src/collect/network";
import type { SendHttp } from "../src/collect/shared/http/capture";
import type { NetworkCaptureRuntime } from "../src/infra/target/network-capture";
import type { ExecResult, Executor, RunOptions } from "../src/infra/k8s/executor";
import type { TerminalProgressUpdate } from "../src/terminal/progress";

function result(command: string[], input: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command,
    ...input,
  };
}

const SERVICES = ["frontend", "planner", "model-gateway"];

function serviceList(): string {
  return JSON.stringify({
    items: SERVICES.map((name, index) => ({
      metadata: { name, namespace: "demo" },
      spec: {
        clusterIP: `10.96.0.${index + 1}`,
        selector: { app: name },
        ports: [{ port: 8000 + index, targetPort: 9000 + index }],
      },
    })),
  });
}

function podList(): string {
  return JSON.stringify({
    items: SERVICES.map((name, index) => ({
      metadata: { name: `${name}-0`, namespace: "demo", labels: { app: name } },
      status: { phase: "Running", podIP: `10.0.0.${index + 1}` },
    })),
  });
}

function podJson(pod: string): string {
  const service = pod.slice(0, -2);
  return JSON.stringify({
    metadata: { name: pod, namespace: "demo" },
    spec: {
      containers: [{ name: service, image: `repo/${service}:1` }],
      ephemeralContainers: [{
        name: `doctor-debug-${service}`,
        image: "repo/doctor-debug:1",
        targetContainerName: service,
        securityContext: { capabilities: { add: ["SYS_PTRACE", "NET_RAW"] } },
      }],
    },
    status: {
      phase: "Running",
      ephemeralContainerStatuses: [{
        name: `doctor-debug-${service}`,
        state: { running: {} },
      }],
    },
  });
}

class NetworkExecutor implements Executor {
  async run(command: string[], _options?: RunOptions): Promise<ExecResult> {
    const joined = command.join(" ");
    if (joined === "get services -o json") return result(command, { stdout: serviceList() });
    if (joined === "get pods -o json") return result(command, { stdout: podList() });
    const pod = joined.match(/^get pod (.+) -o json$/)?.[1];
    if (pod) return result(command, { stdout: podJson(pod) });
    return result(command);
  }

  async exec(_target: { pod: string; container?: string }, command: string[]): Promise<ExecResult> {
    return result(command);
  }
}

function captureRuntime(
  pcap: Buffer,
  stopReason: (pod: string) => string = () => "doctor_stop",
): NetworkCaptureRuntime {
  const digest = createHash("sha256").update(pcap).digest("hex");
  const metadata = (pod: string, running: boolean) => ({
    session_id: "net-test",
    status: running ? "running" : "stopped",
    running,
    capture_file: `/tmp/doctor-net/net-test/${pod}.pcap`,
    capture_bytes: pcap.byteLength,
    capture_sha256: digest,
    stop_reason: running ? undefined : stopReason(pod),
  });
  return {
    inspectReadiness: async (_executor, target) => result(["ready", target.pod]),
    start: async (_executor, target) => ({
      result: result(["start", target.pod]),
      metadata: metadata(target.pod, true),
    }),
    status: async (_executor, target) => ({
      result: result(["status", target.pod]),
      metadata: metadata(target.pod, true),
    }),
    stop: async (_executor, target) => ({
      result: result(["stop", target.pod]),
      metadata: metadata(target.pod, false),
    }),
    metadata: async (_executor, target) => ({
      result: result(["metadata", target.pod]),
      metadata: metadata(target.pod, false),
    }),
    cleanup: async (_executor, target) => ({
      result: result(["cleanup", target.pod]),
      metadata: { session_id: "net-test", status: "cleaned" },
    }),
  };
}

function sendSse(seen: Array<Record<string, string>>): SendHttp {
  return async (request) => {
    seen.push(request.headers);
    const body = new TextEncoder().encode('data: {"event":"end","trace_id":"trace-1"}\n\n');
    return {
      statusCode: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream" },
      body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }),
    };
  };
}

describe("doctor net capture", () => {
  test("每 Pod PCAP 默认容量上限为 1 GiB", () => {
    expect(NETWORK_DEFAULTS.maxPcapMiB).toBe(1024);
  });

  test("未传 --file 时可选择 HTTP 场景进入跟踪模式或直接进入守候模式", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-network-scenarios-"));
    const scenario = (name: string) => `schema: doctor-http/v1
name: ${name}
requests:
  - id: capture
    url: http://example.test/health
`;
    writeFileSync(join(dir, "b.yaml"), scenario("b"));
    writeFileSync(join(dir, "invalid.yaml"), "name: not-a-doctor-scenario\n");

    expect(findNetworkScenarioFiles(dir)).toEqual(["b.yaml"]);
    expect(await resolveNetworkScenarioFile({
      directory: dir,
      interactive: true,
      prompt: async (files) => files[0],
    })).toBe(join(dir, "b.yaml"));

    writeFileSync(join(dir, "a.yml"), scenario("a"));
    expect(await resolveNetworkScenarioFile({
      directory: dir,
      interactive: true,
      prompt: async (files) => {
        expect(files).toEqual(["a.yml", "b.yaml"]);
        return "b.yaml";
      },
    })).toBe(join(dir, "b.yaml"));

    expect(await resolveNetworkScenarioFile({
      directory: dir,
      interactive: true,
      prompt: async () => null,
    })).toBeNull();

    expect(resolveNetworkScenarioFile({
      directory: dir,
      interactive: false,
    })).rejects.toThrow("缺少 --file");
  });

  test("场景包含多个 HTTP 请求时交互选择一个", async () => {
    const requests = [
      {
        requestId: "chat",
        entrypointId: "default",
        method: "POST",
        url: "http://chat.example/api/chat",
        headers: {},
        followRedirects: true,
        timeoutMs: 10_000,
        maxResponseBytes: 1024,
        expect: { status: [200] },
      },
      {
        requestId: "judge",
        entrypointId: "default",
        method: "POST",
        url: "http://judge.example/v1/judge",
        headers: {},
        followRedirects: true,
        timeoutMs: 10_000,
        maxResponseBytes: 1024,
        expect: { status: [200] },
      },
    ];

    const selected = await resolveNetworkRequest(requests, {
      interactive: true,
      prompt: async (choices) => choices[1],
    });
    expect(selected?.requestId).toBe("judge");
    expect(resolveNetworkRequest(requests, { interactive: false }))
      .rejects.toThrow("实际为 2 个");
  });

  test("本次抓包 Service 范围由交互选择，非交互必须显式指定", async () => {
    const loadChoices = async () => [
      { name: "frontend" },
      { name: "planner" },
      { name: "model-gateway-v2" },
    ];
    expect(await resolveNetworkServiceScope({
      interactive: true,
      loadChoices,
      prompt: async (choices, defaults) => {
        expect(choices.map((choice) => choice.name)).toEqual([
          "frontend",
          "planner",
          "model-gateway-v2",
        ]);
        expect(defaults).toEqual([]);
        return ["frontend", "planner"];
      },
    })).toEqual(["frontend", "planner"]);
    expect(await resolveNetworkServiceScope({
      services: "frontend,model-gateway-v2",
      interactive: false,
      loadChoices,
    })).toEqual(["frontend", "model-gateway-v2"]);
    expect(resolveNetworkServiceScope({
      interactive: false,
      loadChoices,
    })).rejects.toThrow("缺少 --services");
  });

  test("失败时生成可直接阅读的终端摘要", () => {
    const summary = formatNetworkFailureSummary({
      code: 1,
      captureMode: "tracking",
      topology: {
        services: [],
        targets: [{
          pod: "frontend-0",
          services: ["frontend"],
          debug: { pod: "frontend-0", container: "doctor-debug" },
          debugImage: "doctor-debug:latest",
        }],
        missing: [
          { service: "model-gateway", reason: "Service 'model-gateway' 不存在", required: true },
          {
            pod: "frontend-0",
            reason: "没有具备 NET_RAW 的 doctor debug environment；请先执行 doctor debug",
            required: true,
          },
        ],
        filter: "tcp",
      },
      artifacts: [],
      traceIds: [],
      reason: "Service 'model-gateway' 不存在",
    });

    expect(summary).toContain("[net] 失败：Service 'model-gateway' 不存在");
    expect(summary).toContain("[net] 必需覆盖缺口（2）：");
    expect(summary).toContain("Pod frontend-0：没有具备 NET_RAW");
    expect(summary).toContain("[net] PCAP：未开始");
    expect(summary).toContain("[net] HTTP：未执行或未取得响应");
  });

  test("容量撞限时区分 PCAP 已校验与观测窗口提前结束", () => {
    const summary = formatNetworkCaptureStatus({
      code: 0,
      captureMode: "watch",
      artifacts: [{
        pod: "workspace-0",
        services: ["workspace"],
        debugContainer: "doctor-debug",
        file: "pods/workspace-0/capture.pcap",
        bytes: 200 * 1024 * 1024,
        sha256: "digest",
        verified: true,
        windowComplete: false,
        reason: "达到每 Pod 容量上限 200.0 MiB 后提前停止；"
          + "已回传的 PCAP 仍可分析，但停止后的流量缺失",
      }],
      traceIds: [],
    });

    expect(summary).toContain("[net] PCAP 回传校验：1/1");
    expect(summary).toContain("[net] 观测窗口：0/1 覆盖到预期停止时刻");
    expect(summary).toContain("已回传的 PCAP 仍可分析");
  });

  test("所有 Pod 只缺 debug environment 时不交付空 Bundle，并给出 Service 级准备命令", () => {
    const result = {
      code: 1,
      captureMode: "tracking" as const,
      topology: {
        services: [
          { name: "frontend", ports: [8000], pods: ["chat-0"], optional: false },
          { name: "planner", ports: [8001], pods: ["planner-0"], optional: false },
        ],
        targets: [],
        missing: [
          {
            pod: "chat-0",
            reason: "没有具备 NET_RAW 的 doctor debug environment；请先执行 doctor debug",
            required: true,
          },
          {
            pod: "planner-0",
            reason: "没有具备 NET_RAW 的 doctor debug environment；请先执行 doctor debug",
            required: true,
          },
        ],
        filter: "tcp",
      },
      artifacts: [],
      traceIds: [],
    };

    expect(isNetworkDebugPrerequisiteFailure(result)).toBe(true);
    expect(formatNetworkDebugRecommendation({
      profileName: "demo",
      namespace: "default",
      services: ["frontend", "planner"],
    })).toContain(
      "mono-doctor doctor debug --profile demo -n default --services frontend,planner",
    );
  });

  test("Service selector 解析全部目标 Pod，并只选择带 NET_RAW 的 debug environment", async () => {
    const inspected = await inspectNetworkTopology(
      new NetworkExecutor(),
      "demo",
      [...SERVICES, "worker"],
    );

    expect(inspected.topology.targets).toHaveLength(3);
    expect(inspected.topology.targets[0]?.debug.container).toStartWith("doctor-debug-");
    expect(inspected.topology.missing).toContainEqual({
      service: "worker",
      reason: "Service 'worker' 不存在",
      required: true,
    });
    expect(inspected.topology.filter).toContain("port 443");
    expect(inspected.topology.filter).toContain("port 9000");
    expect(formatNetworkCaptureScope(inspected.topology)).toContain(
      "[net] 本次抓包范围：4 个 Service，3 个 Running Pod",
    );
  });

  test("全 Pod ARM 后发染色请求，停止、回传并写 NetBundle manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-network-test-"));
    const pcap = Buffer.from("pcap-test-data");
    const seenHeaders: Array<Record<string, string>> = [];
    const deps: NetworkCollectDependencies = {
      executor: new NetworkExecutor(),
      captureRuntime: captureRuntime(pcap),
      downloadFromTarget: async (options) => {
        writeFileSync(options.hostPath, pcap);
        return { ok: true, bytesWritten: pcap.byteLength, slices: 1, retries: 0 };
      },
      sendHttp: sendSse(seenHeaders),
      sleep: async () => undefined,
    };

    const collected = await collectNetwork({
      namespace: "demo",
      services: SERVICES,
      capturePlan: {
        mode: "tracking",
        requestFile: "request.yaml",
        requestSource: "schema: doctor-http/v1\nname: network-test\nrequests: []\n",
        request: {
          requestId: "chat",
          entrypointId: "default",
          method: "POST",
          url: "http://chat.example/api/chat",
          headers: { "Content-Type": "application/json" },
          body: new TextEncoder().encode("{}"),
          followRedirects: true,
          timeoutMs: 10_000,
          maxResponseBytes: 1024,
          expect: { status: [200] },
        },
      },
      timeoutSeconds: 10,
      drainSeconds: 1,
      maxPcapBytes: 1024,
      maxResponseBytes: 1024,
      cleanupRemote: false,
      outputDir: dir,
      sessionId: "net-test",
      captureId: "doctor-test",
    }, deps);

    expect(collected.code).toBe(0);
    expect(collected.artifacts).toHaveLength(3);
    expect(collected.artifacts.every((artifact) => artifact.verified)).toBe(true);
    expect(collected.artifacts.every((artifact) => artifact.windowComplete)).toBe(true);
    expect(collected.traceIds).toEqual(["trace-1"]);
    expect(seenHeaders[0]?.["X-Doctor-Capture-ID"]).toBe("doctor-test");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
    expect(manifest.target.capture_id).toBe("doctor-test");
    expect(manifest.target.trace_ids).toEqual(["trace-1"]);
    expect(manifest.inspection_facts.capture_artifacts).toHaveLength(3);
  });

  test("守候模式等待用户操作完成后停止抓包，不主动发起 HTTP 请求", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-network-listen-test-"));
    const pcap = Buffer.from("listen-pcap-test-data");
    let waited = false;
    const stages: string[] = [];
    const progress: TerminalProgressUpdate[] = [];
    const deps: NetworkCollectDependencies = {
      executor: new NetworkExecutor(),
      captureRuntime: captureRuntime(
        pcap,
        (pod) => pod === "frontend-0" ? "size_limit" : "doctor_stop",
      ),
      downloadFromTarget: async (options) => {
        options.onStart?.(1);
        writeFileSync(options.hostPath, pcap);
        options.onProgress?.({
          slice: 1,
          totalSlices: 1,
          fetchedBytes: pcap.byteLength,
          totalBytes: pcap.byteLength,
        });
        return { ok: true, bytesWritten: pcap.byteLength, slices: 1, retries: 0 };
      },
      sleep: async () => undefined,
      log: (line) => stages.push(line),
      progress: (update) => progress.push(update),
      waitForWatchCompletion: async ({ timeoutMs }) => {
        expect(timeoutMs).toBe(10_000);
        waited = true;
        return "completed";
      },
    };

    const collected = await collectNetwork({
      namespace: "demo",
      services: SERVICES,
      capturePlan: { mode: "watch" },
      timeoutSeconds: 10,
      drainSeconds: 1,
      maxPcapBytes: 1024,
      maxResponseBytes: 1024,
      cleanupRemote: false,
      outputDir: dir,
      sessionId: "net-listen-test",
      captureId: "doctor-listen-test",
    }, deps);

    expect(collected.code).toBe(0);
    expect(collected.captureMode).toBe("watch");
    expect(collected.response).toBeUndefined();
    expect(waited).toBe(true);
    expect(collected.artifacts.every((artifact) => artifact.verified)).toBe(true);
    expect(collected.artifacts.find((artifact) => artifact.pod === "frontend-0"))
      .toMatchObject({ windowComplete: false });
    expect(stages).toContain(
      "已收到页面操作完成信号，开始收尾；PCAP 分析将由 doctor neta 执行。",
    );
    expect(stages).toContain("继续抓包 1 秒，等待尾部流量落盘…");
    expect(stages).toContain("正在停止 3 个 Pod 的抓包…");
    expect(stages).toContain(
      `开始回传并校验 3 个 PCAP（合计 ${pcap.byteLength * 3} B）…`,
    );
    expect(progress.at(-1)).toMatchObject({
      current: pcap.byteLength * 3,
      total: pcap.byteLength * 3,
      detail: "3/3 Pod 校验完成",
      complete: true,
    });
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
    expect(manifest.params.capture_mode).toBe("watch");
    expect(manifest.inspection_facts.capture_artifacts[0]).toHaveProperty("window_complete");
    expect(manifest.inspection_facts.capture_artifacts[0]).not.toHaveProperty("complete");
    expect(manifest.target.capture_mode).toBeUndefined();
    expect(manifest.inspection_facts.response).toBeUndefined();
    expect(manifest.params.http_file).toBeUndefined();
  });
});
