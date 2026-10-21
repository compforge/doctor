import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientManager } from "@compforge/harness-common";
import { kubernetesClientSource, resourceReader, snapshotResourceReader, type KubernetesResourceReader } from "../src/infra/k8s/resources";
import { EvidenceBundle } from "../src/collect/evidence";
import { captureKubernetesWorkloadConfig, resolveKubernetesWorkload } from "../src/infra/k8s/workload-config";

test("Core snapshot and workload discovery share a native client and preserve API evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-native-resources-"));
  const paths: string[] = [];
  let sockets = 0;
  const service = { metadata: { name: "api", namespace: "demo" }, spec: { selector: { app: "api" } } };
  const pod = { metadata: { name: "api-1", namespace: "demo", uid: "pod-uid" }, spec: { containers: [{ name: "api" }] } };
  const server = createServer((request, response) => {
    paths.push(request.url!);
    const url = new URL(request.url!, "http://local");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("/services/api")) response.end(JSON.stringify(service));
    else if (url.pathname.endsWith("/services/missing")) { response.statusCode = 403; response.end("credential must not enter evidence"); }
    else response.end(JSON.stringify({ items: url.pathname.endsWith("/services") ? [service] : [pod] }));
  });
  server.on("connection", () => sockets++);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const config = join(root, "kubeconfig");
  writeFileSync(config, JSON.stringify({ apiVersion: "v1", kind: "Config", "current-context": "fixture",
    contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
    clusters: [{ name: "fixture", cluster: { server: `http://127.0.0.1:${address.port}` } }],
    users: [{ name: "fixture", user: {} }] }));
  const clients = new ClientManager();
  try {
    const source = kubernetesClientSource({ kubeconfig: config, namespace: "demo" });
    const client = await clients.get(source);
    expect(await clients.get(source)).toBe(client);
    const read = resourceReader(client, new AbortController().signal);
    const capture = await captureKubernetesWorkloadConfig(read, "demo", false, true);
    expect(capture.snapshot?.pods[0]?.name).toBe("api-1");
    const bundle = new EvidenceBundle(join(root, "evidence"));
    const resolved = await resolveKubernetesWorkload(capture.snapshot!, {
      name: "main", platform: "kubernetes", location: { kind: "service", name: "api" },
    }, read, "demo", "fixture", result => {
      const step = bundle.addStep({ id: `read-${paths.length}`, title: "Resource read", risk: "observe",
        status: result.error ? "failed" : "ok", request: result.request, durationMs: result.durationMs });
      expect(step.request?.namespace).toBe("demo");
      expect(step.command).toBeUndefined();
    });
    expect(resolved.instances[0]?.uid).toBe("pod-uid");
    expect(paths).toHaveLength(4);
    // The initial two independent snapshot reads may open two sockets; later discovery reuses them.
    expect(sockets).toBeLessThanOrEqual(2);
    const denied = await read({ apiVersion: "v1", resource: "services", namespace: "demo", name: "missing" });
    expect(denied.error).toBeDefined();
    expect(denied.error).not.toContain("credential");
    expect(denied.execution).toBeUndefined();
  } finally {
    await clients.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});


test("Inspect reuses complete successful observations without crossing namespace or selector boundaries", async () => {
  let calls = 0;
  const read: KubernetesResourceReader = async query => {
    calls++;
    return { request: { ...query, verb: "name" in query ? "get" : "list" },
      value: "name" in query ? { metadata: { name: query.name } } : { items: [{ metadata: { name: "api" } }] },
      observedAt: "2026-10-21T00:00:00Z", durationMs: 10 };
  };
  const cached = snapshotResourceReader(read);
  const list = { apiVersion: "v1", resource: "services", namespace: "demo" };
  await cached(list);
  const named = await cached({ ...list, name: "api" });
  expect(named).toMatchObject({ reused: true, durationMs: 0, observedAt: "2026-10-21T00:00:00Z" });
  expect(named.request).toMatchObject({ verb: "get", name: "api" });
  await cached({ ...list, name: "api", namespace: "other" });
  await cached({ ...list, labelSelector: "app=api" });
  expect(calls).toBe(3);
  await snapshotResourceReader(read)(list);
  expect(calls).toBe(4);
});

for (const mode of ["error", "paginated", "filtered"] as const) test(`Inspect ${mode} observation does not establish named resources`, async () => {
  let calls = 0;
  const cached = snapshotResourceReader(async query => {
    calls++;
    return { request: { ...query, verb: "name" in query ? "get" : "list" }, durationMs: 1, observedAt: "now",
      ...(mode === "error" ? { error: "unavailable" } : { value: {
        metadata: mode === "paginated" ? { continue: "next" } : {}, items: [{ metadata: { name: "api" } }],
      } }) };
  });
  const query = { apiVersion: "v1", resource: "services", namespace: "demo" };
  await cached({ ...query, ...(mode === "filtered" ? { labelSelector: "app=api" } : {}) });
  await cached({ ...query, name: "api" });
  expect(calls).toBe(2);
});
