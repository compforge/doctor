import type { FileReadResult } from "@compforge/harness-common";
import { expect, test } from "bun:test";
import { ClientManager } from "@compforge/harness-toolbox/client-manager";
import { createServiceCatalog, fileDataSource, type CapabilityAccess, DOCTOR_PLUGIN_API_VERSION } from "@compforge/doctor-plugin";
import { validatePluginDefinition } from "../src/plugin/definition";
import { createPluginContext } from "../src/plugin/context";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";

const service = {
  name: "api", component: { name: "api", repository: { forge: { name: "test" }, path: "api" } },
  workloads: [{ name: "main", platform: "kubernetes" as const, location: { kind: "labels" as const, labels: { app: "api" } } }],
};
const access: CapabilityAccess = { kubernetes: [{
  rule: { verb: "create", resource: "pods/exec" }, requirement: "required", purpose: "read configuration",
}] };

// @spec File clients outlive capability contexts, but never outlive the root Command.
test("file clients reuse the root lifecycle and observe fresh bytes after borrower disposal", async () => {
  const clients = new ClientManager();
  let resolutions = 0;
  let reads = 0;
  const file = fileDataSource(["/config.yaml"], { workload: "main", access, resolve: async () => {
    resolutions++;
    return { namespace: "demo", pod: "api-0", container: "main" };
  } });
  const executor: Executor = {
    run: async () => { throw new Error("unexpected discovery"); },
    exec: async (_target, command, options) => {
      reads++;
      expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
      expect(command.slice(3)).toEqual(["file-source", "1025", "/config.yaml"]);
      expect(_target).toMatchObject({ namespace: "demo", pod: "api-0", container: "main" });
      options?.onStdoutBytes?.(Buffer.from(`0 ${Buffer.concat([Buffer.from(`version: ${reads}`), Buffer.from([0]), Buffer.from("000")]).toString("base64")}\n`));
      return { ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, command: [] };
    },
  };
  const open = (declared = access) => createPluginContext(executor, { namespace: "demo" }, {
    clients, service, environment: { name: "test", kind: "kubernetes", context: "test", server: "https://cluster.test" },
    capability: { access: declared },
  });
  const first = open();
  const second = open();
  const denied = open({});
  try {
    expect(resolutions).toBe(0);
    const client = await first.clients.get(file);
    await first.dispose();
    expect(await second.clients.get(file)).toBe(client);
    expect(resolutions).toBe(1);
    const limits = { maxBytes: 1024, maxTotalBytes: 1024, timeoutMs: 1000 };
    expect(new TextDecoder().decode(fileBytes(await client.read(limits)))).toBe("version: 1");
    expect(new TextDecoder().decode(fileBytes(await client.read(limits)))).toBe("version: 2");
    await expect(denied.infra.kubernetes.readFiles({ pod: "api-0", container: "main" }, ["/config.yaml"], limits))
      .rejects.toThrow("未声明 Kubernetes access");
    expect(reads).toBe(2);
    const aborted = new AbortController(); aborted.abort(new Error("cancelled read"));
    await expect(client.read({ ...limits, signal: aborted.signal })).rejects.toThrow("cancelled read");
    expect(reads).toBe(2);
    await clients.dispose();
    await expect(client.read(limits)).rejects.toThrow();
  } finally {
    await Promise.all([first.dispose(), second.dispose(), denied.dispose()]);
    await clients.dispose();
  }
});

test("Catalog rejects the removed configurationInspection declaration", () => {
  expect(() => createServiceCatalog([{ ...service, configurationInspection: true }])).toThrow("configurationInspection was removed");
});


test("Plugin boundary accepts direct file declarations and rejects invalid ownership or identity", () => {
  const file = fileDataSource(["/config.yaml"], { workload: "main", access, resolve: async () => {
    throw new Error("Catalog validation must stay offline");
  } });
  const manifest = { manifestVersion: 1 as const, pluginApiVersion: DOCTOR_PLUGIN_API_VERSION,
    id: "test", version: "0.0.1", requiresDoctor: ">=0.1.218", contentDigest: `sha256:${"0".repeat(64)}`,
    main: "./plugin.mjs", skills: [] };
  const validate = (dataSources: unknown) => validatePluginDefinition({ id: "test", version: "0.0.1",
    services: { services: [{ ...service, dataSources }] } }, manifest);
  expect(validate([file]).services.find("api")?.dataSources).toEqual([file]);
  expect(() => validate([file, file])).toThrow("duplicate clientKey");
  expect(() => validate([{ ...file, workload: "unknown" }])).toThrow("unknown workload");
  expect(() => validate([{ ...file, paths: ["relative.yaml"] }])).toThrow("absolute Pod path");
  expect(() => validate(() => [file])).toThrow("must be an array");
});

function fileBytes(results: readonly FileReadResult[]): Uint8Array {
  const first = results[0]!;
  if (first.status === "error") throw first.error;
  return first.bytes;
}
