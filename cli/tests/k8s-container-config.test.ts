import { describe, expect, test } from "bun:test";
import {
  loadDeclaredContainerConfig,
} from "../src/infra/k8s/container-config";
import type { ExecResult, Executor } from "../src/infra/k8s/executor";

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
});
