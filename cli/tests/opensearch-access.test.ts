import { describe, expect, test } from "bun:test";
import {
  confirmOpenSearchConnection,
} from "../src/collect/shared/opensearch-access";
import type { ExecResult, Executor } from "../src/infra/k8s/executor";

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

  test("外部 FQDN 保持 Doctor Host 直连，不误作 K8s Service", async () => {
    const confirmation = await confirmOpenSearchConnection({
      configuredEndpoint: "https://search.example.com:9200",
      kube: { namespace: "app-ns" },
    }, () => {});

    expect(confirmation.connection).toMatchObject({
      kind: "direct",
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
