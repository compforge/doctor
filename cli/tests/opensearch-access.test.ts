import { createServer } from "node:http";
import { ClientManager } from "@compforge/harness-common";
import { OpenSearchClient } from "@compforge/harness-toolbox/opensearch";
import { PodRelayTransport } from "@compforge/harness-toolbox/transport";
import { sharedPodRelay } from "../src/datasource/pod-relay";
import { inCommandScope } from "../src/command/execution-scope";
import { describe, expect, spyOn, test } from "bun:test";
import {
  confirmOpenSearchConnection, prepareOpenSearchAccess,
} from "../src/collect/shared/opensearch-access";
import type { ExecResult, Executor } from "@compforge/harness-toolbox/kubernetes/executor";

function result(command: string[], stdout: string): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command,
  };
}

describe("OpenSearch connection confirmation", () => {
  test("配置 endpoint 的 namespace、端口和 scheme 都是权威事实", async () => {
    const services = JSON.stringify({
      items: [{
        metadata: { namespace: "search-ns", name: "os" },
        spec: { clusterIP: "10.0.0.8", ports: [{ port: 9200 }, { port: 9443 }] },
      }],
    });
    const executor: Executor = {
      run: async (args) => result(args, services),
      exec: async () => {
        throw new Error("not used");
      },
    };

    const confirmation = await confirmOpenSearchConnection({
      configuredEndpoint: "https://os.search-ns.svc:9443",
      kube: { namespace: "app-ns" },
    }, () => {}, executor);

    expect(confirmation.connection).toEqual({
      kind: "service",
      service: { namespace: "search-ns", name: "os", port: 9443 },
      scheme: "https",
    });
  });

  test("运行配置的外部 FQDN 保留 Target 身份，不误作 K8s Service", async () => {
    const confirmation = await confirmOpenSearchConnection({
      configuredEndpoint: "https://search.example.com:9200",
      kube: { namespace: "app-ns" },
    }, () => {});

    expect(confirmation.connection).toMatchObject({
      kind: "target",
      endpoint: "https://search.example.com:9200",
    });
  });

  test("没有 target 配置时跨 namespace 自动发现并标记 warning", async () => {
    const services = JSON.stringify({
      items: [{
        metadata: { namespace: "search-ns", name: "opensearch" },
        spec: { clusterIP: "10.0.0.8", ports: [{ port: 9200 }] },
      }],
    });
    const executor: Executor = {
      run: async (args) => result(args, services),
      exec: async () => {
        throw new Error("not used");
      },
    };
    const logs: Array<{ line: string; tone?: string }> = [];

    const confirmation = await confirmOpenSearchConnection(
      { kube: { kubeconfig: "/tmp/test-kubeconfig" } },
      (line, tone) => logs.push({ line, tone }),
      executor,
    );

    expect(confirmation.connection).toMatchObject({
      kind: "service",
      service: { namespace: "search-ns", name: "opensearch", port: 9200 },
    });
    expect(logs).toEqual([{
      line: "[collect] 未取得 OpenSearch target 配置，跨 namespace 自动发现 service…",
      tone: "warning",
    }]);
  });
});

test("explicit Host endpoint overrides target configuration and never enables relay", async () => {
  const confirmation = await confirmOpenSearchConnection({
    endpoint: "http://host.invalid:9200", configuredEndpoint: "http://target.invalid:9200",
    kube: { namespace: "app-ns" },
  }, () => {});
  expect(confirmation.connection).toMatchObject({ kind: "direct", endpoint: "http://host.invalid:9200" });
});

test("target connection uses the root relay and reports the selected path only after a real probe", async () => {
  const root = new ClientManager();
  let probes = 0;
  const server = createServer((req, res) => {
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from("reader:secret").toString("base64")}`);
    if (req.method === "HEAD") { probes++; res.end(); }
    else { res.setHeader("content-type", "application/json"); res.end('{"count":12}'); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const kube = { namespace: "test", context: "fixture" };
  const existing = await sharedPodRelay(root, kube);
  const borrowed: object[] = [];
  const relay = spyOn(PodRelayTransport.prototype, "connect").mockImplementation(function (this: object) {
    borrowed.push(this);
    return Promise.resolve({ host: "127.0.0.1", port });
  });
  const dispose = spyOn(PodRelayTransport.prototype, "dispose");
  const logs: string[] = [];
  try {
    await inCommandScope(new AbortController().signal, async () => {
      const prepared = await prepareOpenSearchAccess({ connection: {
        kind: "target", endpoint: "http://search.invalid:9200", username: "reader", password: "secret",
      }, kube, auth: {} }, line => logs.push(line));
      expect(prepared.failure).toBeUndefined();
      expect(prepared.channel).toBe("Pod relay（test）");
      expect(prepared.baseUrl).toBe("http://search.invalid:9200");
      expect(await prepared.search!.count("spans", {})).toBe(12);
      expect(prepared.steps.find(step => step.id === "channel")).toMatchObject({
        status: "ok", output: "transport=pod-relay fallback_reason=ConnectionError",
      });
      expect(probes).toBe(1);
      expect(borrowed).toEqual([existing]);
      expect(logs.join("\n")).not.toContain("secret");
      await prepared.close();
      expect(dispose).not.toHaveBeenCalled();
    }, root);
    await root.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    await root.dispose(); relay.mockRestore(); dispose.mockRestore();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("failed Host connection records a failed channel and cannot use the cluster fallback", async () => {
  const relay = spyOn(PodRelayTransport.prototype, "connect").mockRejectedValue(new Error("unexpected relay"));
  try {
    const prepared = await prepareOpenSearchAccess({
      connection: { kind: "direct", endpoint: "http://search.invalid:9200" }, kube: { namespace: "test" }, auth: {},
    }, () => {});
    expect(prepared.failure?.title).toBe("OpenSearch 连接失败");
    expect(prepared.steps.filter(step => step.id === "channel").map(step => step.status)).toEqual(["failed"]);
    expect(relay).not.toHaveBeenCalled();
    await prepared.close();
  } finally { relay.mockRestore(); }
});

test("local target preparation releases its relay when closed", async () => {
  const server = createServer((_req, res) => res.end());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const relay = spyOn(PodRelayTransport.prototype, "connect").mockResolvedValue({ host: "127.0.0.1", port });
  const dispose = spyOn(PodRelayTransport.prototype, "dispose");
  try {
    const prepared = await prepareOpenSearchAccess({
      connection: { kind: "target", endpoint: "http://search.invalid:9200" }, kube: { namespace: "test" }, auth: {},
    }, () => {});
    expect(prepared.failure).toBeUndefined();
    await prepared.close(); await prepared.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    relay.mockRestore(); dispose.mockRestore();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// @case Collect keeps original stack evidence and standalone cleanup failure after access-layer adaptation.
test("standalone preparation retains original diagnostics and cleanup evidence", async () => {
  const original = Object.assign(new TypeError("invalid TLS servername"), { code: "ERR_INVALID_ARG_VALUE" });
  original.stack = "TypeError: invalid TLS servername\n    at originalProbe (https://fixture-user:fixture-secret@search.invalid/probe.ts:12:3)";
  const initialize = spyOn(OpenSearchClient.prototype, "initialize").mockRejectedValue(original);
  const close = spyOn(OpenSearchClient.prototype, "close").mockRejectedValue(new Error("fixture cleanup failure"));
  const logs: string[] = [];
  try {
    const access = await prepareOpenSearchAccess({ connection: { kind: "direct", endpoint: "https://search.invalid:9200",
      username: "fixture-user", password: "fixture-secret" }, auth: {} }, line => logs.push(line));
    expect(access.failure?.reason).toStartWith("invalid TLS servername; cleanup failed:");
    expect(access.steps.filter(step => step.id === "opensearch-cleanup")).toHaveLength(1);
    expect(access.steps.find(step => step.id === "opensearch-cleanup")?.status).toBe("failed");
    const evidence = access.steps.find(step => step.id === "opensearch-access")?.output as string;
    expect(evidence).toContain("ERR_INVALID_ARG_VALUE");
    expect(evidence.match(/originalProbe/g)).toHaveLength(1);
    expect(access.failure?.diagnostics?.join("\n")).toContain("originalProbe");
    expect(evidence).not.toContain("fixture-user");
    expect(evidence).not.toContain("fixture-secret");
    expect(logs.filter(line => line.includes("OpenSearch 连接失败"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("originalProbe");
    await access.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    initialize.mockRestore(); close.mockRestore();
  }
});
