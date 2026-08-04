import { describe, expect, test } from "bun:test";
import {
  loadDeclaredContainerConfig,
} from "../src/infra/k8s/container-config";
import type { ExecResult, Executor } from "../src/infra/k8s/executor";
import { confirmVdbTarget } from "../src/collect/store/vdb/configuration";
import type { ServiceVdbStoreCapability } from "@compforge/doctor-plugin";

function result(command: string[], stdout: string, ok = true): ExecResult {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    stdout,
    stderr: ok ? "" : "not found",
    durationMs: 1,
    timedOut: false,
    command,
  };
}

describe("declared Container config", () => {
  test("从 Pod env/ConfigMap/Secret 与挂载文件还原配置，不需要 exec", async () => {
    const pod = {
      spec: {
        containers: [{
          name: "app-server",
          env: [
            { name: "APP_CONFIG_PATH", value: "/etc/app/config.json" },
            { name: "OPENSEARCH_PASSWORD", valueFrom: { secretKeyRef: { name: "os-auth", key: "password" } } },
          ],
          volumeMounts: [{ name: "app", mountPath: "/etc/app" }],
        }],
        volumes: [{ name: "app", configMap: { name: "app-config" } }],
      },
    };
    const responses: Record<string, string> = {
      "get pod app-0 -o json": JSON.stringify(pod),
      "get secret os-auth -o json": JSON.stringify({
        data: { password: Buffer.from("secret").toString("base64") },
      }),
      "get configmap app-config -o json": JSON.stringify({
        data: { "config.json": JSON.stringify({ feature: { enabled: true } }) },
      }),
    };
    const executor: Executor = {
      run: async (args) => result(args, responses[args.join(" ")] ?? "", args.join(" ") in responses),
      exec: async () => {
        throw new Error("declared config must not use pods/exec");
      },
    };

    const config = await loadDeclaredContainerConfig(executor, {
      pod: "app-0",
      container: "app-server",
    });

    expect(config.environment.get("APP_CONFIG_PATH")).toBe("/etc/app/config.json");
    expect(config.environment.get("OPENSEARCH_PASSWORD")).toBe("secret");
    expect(config.files.get("/etc/app/config.json")).toContain('"enabled":true');
    expect(config.captures).toHaveLength(3);
  });

  test("VDB capability 可以把自定义挂载文件投影为统一 target", async () => {
    const pod = {
      spec: {
        containers: [{
          name: "search-api",
          env: [{ name: "SEARCH_CONFIG_PATH", value: "/etc/search/target.json" }],
          volumeMounts: [{ name: "search", mountPath: "/etc/search" }],
        }],
        volumes: [{ name: "search", configMap: { name: "search-config" } }],
      },
    };
    const responses: Record<string, string> = {
      "get pod search-api-0 -o json": JSON.stringify(pod),
      "get configmap search-config -o json": JSON.stringify({
        data: { "target.json": JSON.stringify({ endpoint: "http://search:9200" }) },
      }),
    };
    const executor: Executor = {
      run: async (args) => result(args, responses[args.join(" ")] ?? "", args.join(" ") in responses),
      exec: async () => {
        throw new Error("declared config must not use pods/exec");
      },
    };
    const capability: ServiceVdbStoreCapability = {
      id: "search",
      kind: "vdb",
      backend: "opensearch",
      configuration: {
        file: {
          pathEnvironment: "SEARCH_CONFIG_PATH",
          defaultPath: "/etc/search/target.json",
        },
        resolve: ({ file }) => ({
          backend: "opensearch",
          store: "search",
          endpoint: JSON.parse(file!.content).endpoint,
          configurationKind: "plugin-file",
          configPath: file!.path,
        }),
      },
    };

    const confirmed = await confirmVdbTarget(executor, {
      pod: "search-api-0",
      container: "search-api",
    }, capability);

    expect(confirmed.connection).toEqual({
      type: "opensearch",
      store: "search",
      endpoint: "http://search:9200",
      username: undefined,
      password: undefined,
      configSource: "kubernetes-config",
      configurationKind: "plugin-file",
      configPath: "/etc/search/target.json",
    });
  });
});
