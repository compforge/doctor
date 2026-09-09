import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Response as NodeFetchResponse } from "node-fetch";
import {
  ClientNodePodLogAccess,
  type ClientNodeFetch,
} from "../src/infra/k8s/client-node-pod-log";
import { inCommandScope } from "../src/command/execution-scope";
import type { KubernetesPodLogAccess } from "../src/infra/k8s/pod-log";

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function accessFor(
  server: ReturnType<typeof Bun.serve>,
  policy?: { idleTimeoutMs?: number; hardTimeoutMs?: number; maxAttempts?: number },
  fetchImpl?: ClientNodeFetch,
  config: { cluster?: Record<string, string | boolean>; user?: Record<string, string> } = {},
): ClientNodePodLogAccess {
  const root = mkdtempSync(join(tmpdir(), "doctor-client-node-log-"));
  roots.push(root);
  const kubeconfig = join(root, "kubeconfig.yaml");
  writeFileSync(kubeconfig, JSON.stringify({
    apiVersion: "v1", kind: "Config",
    clusters: [{ name: "test", cluster: {
      server: server.url.toString().replace("127.0.0.1", "localhost"), ...config.cluster,
    } }],
    contexts: [{ name: "test", context: { cluster: "test", user: "test" } }],
    "current-context": "test",
    users: [{ name: "test", user: config.user ?? {} }],
  }), "utf8");
  const discovery: KubernetesPodLogAccess = {
    clientVersion: async () => { throw new Error("unexpected clientVersion"); },
    listServicePods: async () => { throw new Error("unexpected listServicePods"); },
    collectPodLogs: async () => { throw new Error("unexpected delegate collectPodLogs"); },
  };
  return new ClientNodePodLogAccess(discovery, {
    namespace: "doctor-test",
    kubeconfig,
    policy,
    fetchImpl,
  });
}

describe("ClientNodePodLogAccess", () => {
  test("通过 Pod Log API 流式落盘，并在本地补齐 pod/container 前缀", async () => {
    let requested: URL | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requested = new URL(request.url);
        return new Response([
          "2026-09-02T01:00:00.000000000Z INFO trace-a first",
          "2026-09-02T01:00:01.000000000Z INFO trace-a second",
          "",
        ].join("\n"));
      },
    });
    servers.push(server);
    const access = accessFor(server);
    const rawFilePath = join(roots.at(-1)!, "capture.log");
    const lines: string[] = [];

    const result = await access.collectPodLogs({
      pod: "api-0",
      container: "app",
      prefix: true,
      since: "6h",
      limitBytes: 1024 * 1024,
      rawFilePath,
      onLine: (line) => lines.push(line),
    });

    expect(result.stderr).toBe("");
    expect(result.captureStatus).toBe("complete");
    expect(result.attempts).toBe(1);
    expect(result.bytesRead).toBeGreaterThan(0);
    expect(requested?.pathname).toBe("/api/v1/namespaces/doctor-test/pods/api-0/log");
    expect(requested?.searchParams.get("container")).toBe("app");
    expect(requested?.searchParams.get("sinceSeconds")).toBe(String(6 * 60 * 60));
    expect(lines).toEqual([
      "[pod/api-0/app] 2026-09-02T01:00:00.000000000Z INFO trace-a first",
      "[pod/api-0/app] 2026-09-02T01:00:01.000000000Z INFO trace-a second",
    ]);
    expect(readFileSync(rawFilePath, "utf8")).toBe(`${lines.join("\n")}\n`);
  });

  test("流已经产出字节后 idle timeout，返回 partial 而不是 unavailable", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("unused"),
    });
    servers.push(server);
    const stream = new PassThrough();
    const fetchImpl: ClientNodeFetch = async (_url, init) => {
      stream.write("2026-09-02T01:00:00Z INFO trace-a arrived\n");
      init?.signal?.addEventListener("abort", () => stream.end(), { once: true });
      return new NodeFetchResponse(stream);
    };
    const access = accessFor(server, {
      idleTimeoutMs: 20,
      hardTimeoutMs: 200,
      maxAttempts: 1,
    }, fetchImpl);
    const rawFilePath = join(roots.at(-1)!, "partial.log");

    const result = await access.collectPodLogs({
      pod: "api-0",
      container: "app",
      rawFilePath,
    });

    expect(result.captureStatus).toBe("partial");
    expect(result.timedOut).toBeTrue();
    expect(result.bytesRead).toBeGreaterThan(0);
    expect(readFileSync(rawFilePath, "utf8")).toContain("trace-a arrived");
  });

  test("瞬态 HTTP 错误按策略重试", async () => {
    let attempts = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        attempts += 1;
        return attempts === 1
          ? new Response("temporarily unavailable", { status: 503 })
          : new Response("2026-09-02T01:00:00Z INFO trace-a recovered\n");
      },
    });
    servers.push(server);
    const access = accessFor(server);

    const result = await access.collectPodLogs({ pod: "api-0", container: "app" });

    expect(result.captureStatus).toBe("complete");
    expect(result.attempts).toBe(2);
    expect(attempts).toBe(2);
    expect(result.stdout).toContain("trace-a recovered");
  });
});

// Public test-only CA/keys, valid 2020–2120; never used outside the local HTTPS fixtures.
const tlsFixture = (name: string) => readFileSync(new URL(`./fixtures/pod-log-tls/${name}.pem`, import.meta.url), "utf8");
const ca = tlsFixture("ca");
const trustedCluster = { "certificate-authority-data": Buffer.from(ca).toString("base64") };

function httpsServer(requireClientCertificate = false) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    tls: {
      key: tlsFixture("server-key"), cert: tlsFixture("server-cert"), ca,
      requestCert: requireClientCertificate, rejectUnauthorized: requireClientCertificate,
    },
    fetch: () => new Response("2026-09-09T11:00:00Z INFO trace-tls collected\n"),
  });
  servers.push(server);
  return server;
}

const logRequest = { pod: "api-0", container: "app" };
const oneAttempt = { maxAttempts: 1, idleTimeoutMs: 1_000, hardTimeoutMs: 2_000 };

describe("Pod Log kubeconfig HTTP(S)", () => {
  test("HTTPS trusts inline or file CA without a separate transport flag", async () => {
    const server = httpsServer();
    for (const cluster of [trustedCluster, {
      "certificate-authority": new URL("./fixtures/pod-log-tls/ca.pem", import.meta.url).pathname,
    }]) {
      const access = accessFor(server, oneAttempt, undefined, { cluster });
      const result = await access.collectPodLogs(logRequest);
      expect(result.stderr).toBe("");
      expect(result.captureStatus).toBe("complete");
      expect(result.stdout).toContain("trace-tls collected");
    }
  });

  test("HTTPS preserves streamed evidence when the real connection reaches idle timeout", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      tls: { key: tlsFixture("server-key"), cert: tlsFixture("server-cert") },
      fetch: () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("2026-09-09T11:00:00Z INFO partial-tls\n"));
        },
      })),
    });
    servers.push(server);
    const result = await accessFor(server, {
      idleTimeoutMs: 250, hardTimeoutMs: 2_000, maxAttempts: 1,
    }, undefined, { cluster: trustedCluster }).collectPodLogs(logRequest);
    expect(result.captureStatus).toBe("partial");
    expect(result.timedOut).toBeTrue();
    expect(result.stdout).toContain("partial-tls");
  });

  test("HTTPS rejects an untrusted certificate and does not downgrade to HTTP", async () => {
    const result = await accessFor(httpsServer(), oneAttempt).collectPodLogs(logRequest);
    expect(result.captureStatus).toBe("unavailable");
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/certificate|issuer/i);
  });

  test("HTTPS only skips verification when kubeconfig explicitly requests it", async () => {
    const access = accessFor(httpsServer(), oneAttempt, undefined, {
      cluster: { "insecure-skip-tls-verify": true },
    });
    expect((await access.collectPodLogs(logRequest)).captureStatus).toBe("complete");
  });

  test("HTTPS honors tls-server-name and otherwise verifies the URL hostname", async () => {
    const server = httpsServer();
    const cluster = { ...trustedCluster, server: server.url.toString() };
    const rejected = await accessFor(server, oneAttempt, undefined, { cluster }).collectPodLogs(logRequest);
    expect(rejected.captureStatus).toBe("unavailable");
    const accepted = await accessFor(server, oneAttempt, undefined, {
      cluster: { ...cluster, "tls-server-name": "localhost" },
    }).collectPodLogs(logRequest);
    expect(accepted.stderr).toBe("");
    expect(accepted.captureStatus).toBe("complete");
  });

  test("HTTPS authenticates using kubeconfig client certificate and key", async () => {
    const server = httpsServer(true);
    const denied = await accessFor(server, oneAttempt, undefined, { cluster: trustedCluster }).collectPodLogs(logRequest);
    expect(denied.captureStatus).toBe("unavailable");
    const authenticated = await accessFor(server, oneAttempt, undefined, {
      cluster: trustedCluster,
      user: {
        "client-certificate-data": Buffer.from(tlsFixture("client-cert")).toString("base64"),
        "client-key-data": Buffer.from(tlsFixture("client-key")).toString("base64"),
      },
    }).collectPodLogs(logRequest);
    expect(authenticated.stderr).toBe("");
    expect(authenticated.captureStatus).toBe("complete");
  });
});


test("command cancellation closes an active HTTPS log stream without retry and retains raw evidence", async () => {
  let requests = 0;
  const controller = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    tls: { key: tlsFixture("server-key"), cert: tlsFixture("server-cert") },
    fetch: () => {
      requests++;
      return new Response(new ReadableStream({
        start(stream) { stream.enqueue(new TextEncoder().encode("2026-09-09T11:00:00Z INFO before-cancel\n")); },
      }));
    },
  });
  servers.push(server);
  const access = accessFor(server, { idleTimeoutMs: 2_000, hardTimeoutMs: 3_000, maxAttempts: 2 }, undefined, { cluster: trustedCluster });
  const rawFilePath = join(roots.at(-1)!, "cancelled.log");
  const result = await inCommandScope(controller.signal, () => access.collectPodLogs({
    ...logRequest, rawFilePath, onLine: () => controller.abort(),
  }));
  expect(result.captureStatus).toBe("partial");
  expect(result.reason).toBe("cancelled");
  expect(result.timedOut).toBeFalse();
  expect(result.attempts).toBe(1);
  expect(requests).toBe(1);
  expect(readFileSync(rawFilePath, "utf8")).toContain("before-cancel");
});

describe("Pod Log upper time boundary and buffered evidence", () => {
  test("inclusive nanosecond boundary closes a live stream without retrying or emitting later records", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
    servers.push(server);
    let attempts = 0;
    let aborted = false;
    const stream = new PassThrough();
    const fetchImpl: ClientNodeFetch = async (url, init) => {
      attempts++;
      // until-time is enforced by the reader; Kubernetes has no such query parameter.
      expect(new URL(String(url)).searchParams.has("untilTime")).toBeFalse();
      init?.signal?.addEventListener("abort", () => { aborted = true; stream.end(); }, { once: true });
      stream.write("2026-09-09T01:00:00.123456788Z INFO trace-a before\n");
      stream.write("2026-09-09T01:00:00.123456789Z ERROR trace-a at-boundary\n");
      stream.write("    stack continuation\n");
      stream.write("2026-09-09T01:00:00.123456790Z INFO trace-a outside\n");
      return new NodeFetchResponse(stream);
    };
    const access = accessFor(server, oneAttempt, fetchImpl);
    const rawFilePath = join(roots.at(-1)!, "window.log");
    const lines: string[] = [];
    const result = await access.collectPodLogs({
      ...logRequest, untilTime: "2026-09-09T01:00:00.123456789Z", rawFilePath,
      onLine: (line) => lines.push(line),
    });
    expect(result.captureStatus).toBe("complete");
    expect(result.timedOut).toBeFalse();
    expect(aborted).toBeTrue();
    expect(attempts).toBe(1);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("at-boundary");
    expect(readFileSync(rawFilePath, "utf8")).toBe(lines.join("\n") + "\n");
    expect(readFileSync(rawFilePath, "utf8")).not.toContain("outside");
  });

  test("EOF after an empty requested window is complete and preserves an empty raw file", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => new Response("2026-09-09T01:00:01Z INFO outside") });
    servers.push(server);
    const access = accessFor(server);
    const rawFilePath = join(roots.at(-1)!, "empty-window.log");
    const result = await access.collectPodLogs({ ...logRequest, untilTime: "2026-09-09T01:00:00Z", rawFilePath });
    expect(result.captureStatus).toBe("complete");
    expect(readFileSync(rawFilePath, "utf8")).toBe("");
    expect(result.bytesRead).toBeGreaterThan(0);
  });

  test("batched writes preserve multibyte logs across transport chunks and flush the final buffer", async () => {
    const payload = Array.from({ length: 2500 }, (_, i) => `2026-09-09T01:00:00Z trace-a 中文日志 ${i}\n`).join("");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(payload) });
    servers.push(server);
    const access = accessFor(server);
    const rawFilePath = join(roots.at(-1)!, "buffered.log");
    const result = await access.collectPodLogs({ ...logRequest, rawFilePath });
    expect(result.captureStatus).toBe("complete");
    expect(result.bytesRead).toBe(Buffer.byteLength(payload));
    expect(readFileSync(rawFilePath, "utf8")).toBe(payload);
  });
});
