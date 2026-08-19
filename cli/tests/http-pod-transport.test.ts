import { describe, expect, spyOn, test } from "bun:test";
import {
  parseHttpExecutionLocation,
  resolveHttpExecutionLocation,
} from "../src/collect/http";
import { resolvePodHttpExecution } from "../src/collect/http/execution";
import type { ExecResult, Executor, RunOptions } from "../src/infra/k8s/executor";
import { inspectLocalHttpEndpoint } from "../src/infra/http";
import {
  buildPodCurlCommand,
  buildPodEndpointInspectCommand,
  createPodHttpEndpointInspector,
  createPodHttpSender,
  supportsPodCurlDiagnostics,
} from "../src/infra/http/pod";
import { CommandContext } from "../src/command";

const encoder = new TextEncoder();

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command: [],
    ...overrides,
  };
}

async function readBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return output + decoder.decode();
    output += decoder.decode(value, { stream: true });
  }
}

describe("HTTP 请求执行位置", () => {
  test("显式值校验，--pod 自动切换为 pod，非交互默认 local", async () => {
    expect(parseHttpExecutionLocation(" POD ")).toBe("pod");
    expect(() => parseHttpExecutionLocation("remote")).toThrow("local 或 pod");
    expect(await resolveHttpExecutionLocation({ pod: "chat-0", interactive: false })).toBe("pod");
    expect(await resolveHttpExecutionLocation({ interactive: false })).toBe("local");
    await expect(resolveHttpExecutionLocation({
      location: "local",
      pod: "chat-0",
      interactive: false,
    })).rejects.toThrow("不能与 --pod/--container 同时使用");
  });

  test("交互终端先选择 local/pod", async () => {
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await resolveHttpExecutionLocation({
        interactive: true,
        prompt: async () => "pod",
      })).toBe("pod");
      expect(write).toHaveBeenCalledWith("[http] 请选择请求执行位置：\n");
    } finally {
      write.mockRestore();
    }
  });
});

describe("Pod HTTP transport", () => {
  test("curl 7.63 起启用 stderr write-out，旧版本保持基础传输", () => {
    expect(supportsPodCurlDiagnostics("curl 7.29.0 (x86_64-redhat-linux-gnu)")).toBe(false);
    expect(supportsPodCurlDiagnostics("curl 7.63.0 (x86_64-pc-linux-gnu)")).toBe(true);
    expect(supportsPodCurlDiagnostics("curl 8.0.0 (x86_64-pc-linux-gnu)")).toBe(true);
    expect(supportsPodCurlDiagnostics("unknown")).toBe(false);
  });

  test("local Inspect 只做 DNS/TCP handshake", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    try {
      const inspected = await inspectLocalHttpEndpoint({
        scheme: "http",
        host: "127.0.0.1",
        port: server.port,
      }, 1_000);
      expect(inspected).toMatchObject({ reachable: true, phase: "tcp" });
    } finally {
      server.stop(true);
    }
  });

  test("Pod Inspect 用无业务 header/body 的 HEAD 探测 origin", async () => {
    let command: string[] = [];
    const executor: Executor = {
      run: async () => result(),
      exec: async (_target, argv) => {
        command = argv;
        return result({
          command: argv,
          stdout: "doctor-connect:10.0.0.8\t8443\t0.012\n",
        });
      },
    };
    const inspect = createPodHttpEndpointInspector(executor, { pod: "chat-0", container: "chat" });
    const endpoint = { scheme: "https" as const, host: "chat.example.test", port: 8443 };

    expect(await inspect(endpoint, 3_000)).toMatchObject({
      reachable: true,
      phase: "tcp",
      remoteAddress: "10.0.0.8",
    });
    expect(command).toEqual(buildPodEndpointInspectCommand(endpoint, 3_000));
    expect(command).toContain("--head");
    expect(command).toContain("--noproxy");
    expect(command).not.toContain("--location");
  });

  test("curl 在目标 Container 内执行，并把最终 response body 保持为流", async () => {
    let capturedTarget: unknown;
    let capturedCommand: string[] = [];
    let capturedOptions: RunOptions | undefined;
    const executor: Executor = {
      run: async () => result(),
      exec: async (target, command, options) => {
        capturedTarget = target;
        capturedCommand = command;
        capturedOptions = options;
        const raw = encoder.encode([
          "HTTP/1.1 302 Found\r\n",
          "location: /final\r\n\r\n",
          "HTTP/1.1 200 OK\r\n",
          "content-type: text/event-stream\r\n",
          "x-request-id: req-1\r\n\r\n",
          "event: end\ndata: {}\n\n",
        ].join(""));
        options?.onStdoutBytes?.(raw.subarray(0, 41));
        options?.onStdoutBytes?.(raw.subarray(41));
        return result({
          command,
          stderr: [
            "doctor-http-transport:v1",
            "10.0.0.8",
            "8080",
            "10.0.0.7",
            "43120",
            "0.001",
            "0.004",
            "0.000",
            "0.004",
            "0.025",
            "0.030",
            "0.000",
            "http://frontend/stream",
            "1",
            "1.1",
            "0",
            "17",
            "21",
          ].join("\t") + "\n",
        });
      },
    };
    const request = {
      url: "http://frontend/stream",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encoder.encode('{"query":"hello"}'),
      followRedirects: true,
      timeoutMs: 12_000,
    };
    const send = createPodHttpSender(executor, { pod: "chat-0", container: "chat" }, true);
    const response = await send(request, new AbortController().signal);

    expect(capturedTarget).toEqual({ pod: "chat-0", container: "chat" });
    expect(capturedCommand).toEqual(buildPodCurlCommand(request, true));
    expect(capturedCommand).toContain("--write-out");
    expect(capturedOptions?.collectStdout).toBe(false);
    expect(capturedOptions?.stdin).toEqual(encoder.encode('{"query":"hello"}'));
    expect(response).toMatchObject({
      statusCode: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream", "x-request-id": "req-1" },
    });
    expect(await readBody(response.body)).toBe("event: end\ndata: {}\n\n");
    expect(response.diagnostics).toEqual({
      engine: "curl",
      remoteAddress: "10.0.0.8",
      remotePort: 8080,
      localAddress: "10.0.0.7",
      localPort: 43120,
      finalUrl: "http://frontend/stream",
      redirectCount: 1,
      httpVersion: "1.1",
      timings: {
        dnsMs: 1,
        tcpMs: 3,
        tlsMs: undefined,
        firstByteMs: 21,
        downloadMs: 5,
        redirectMs: 0,
        totalMs: 30,
      },
      tls: undefined,
      exitCode: 0,
      error: undefined,
      uploadedBytes: 17,
      downloadedBytes: 21,
    });
  });

  test("Pod/Container 解析复用 collect 公共 selector，并在执行前确认 curl", async () => {
    const podList = JSON.stringify({
      items: [{
        metadata: { name: "chat-0" },
        spec: { containers: [{ name: "chat", image: "repo/chat:1" }] },
        status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0 }] },
      }],
    });
    const calls: Array<{ target: unknown; command: string[] }> = [];
    const executor: Executor = {
      run: async (command) => result({ stdout: podList, command }),
      exec: async (target, command) => {
        calls.push({ target, command });
        return result({ stdout: "curl 8.0.0\n", command });
      },
    };
    const execution = await resolvePodHttpExecution({
      namespace: "default",
      pod: "chat-0",
      interactive: false,
    }, new CommandContext({}), executor);

    expect(execution?.target).toEqual({
      kind: "pod",
      namespace: "default",
      pod: "chat-0",
      container: "chat",
    });
    expect(calls).toEqual([{
      target: { pod: "chat-0", container: "chat" },
      command: ["curl", "--version"],
    }]);
  });
});
