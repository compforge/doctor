import { createServer } from "node:http";
import { ClientManager } from "@compforge/harness-common";
import { OpenSearchClient } from "@compforge/harness-toolbox/opensearch";
import { ServicePortForwardTransport } from "@compforge/harness-toolbox/transport";
import { expect, spyOn, test } from "bun:test";
import { openOpenSearchAccess, OpenSearchAccessError } from "../src/datasource/opensearch/access";

// @case OpenSearch access works without a Command scope and borrows transports from an explicit root.
test("service access preserves logical identity and shares transport across short-lived clients", async () => {
  const root = new ClientManager();
  let probes = 0;
  const server = createServer((request, response) => {
    expect(request.headers.host).toBe("os.search.svc:9200");
    if (request.method === "HEAD") probes++;
    response.setHeader("content-type", "application/json");
    response.end(request.method === "HEAD" ? undefined : '{"count":3}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const initialize = spyOn(ServicePortForwardTransport.prototype, "initialize").mockResolvedValue();
  const borrowed: object[] = [];
  const connect = spyOn(ServicePortForwardTransport.prototype, "connect").mockImplementation(function (this: object, endpoint) {
    expect(endpoint).toEqual({ host: "os.search.svc", port: 9200 });
    borrowed.push(this);
    return Promise.resolve({ host: "127.0.0.1", port });
  });
  const dispose = spyOn(ServicePortForwardTransport.prototype, "dispose");
  try {
    for (let i = 0; i < 2; i++) {
      const access = await openOpenSearchAccess({ connection: { kind: "service", scheme: "http",
        service: { name: "os", namespace: "search", port: 9200 } }, kube: { namespace: "app" }, auth: {}, clients: root });
      expect(access.baseUrl).toBe("http://os.search.svc:9200");
      expect(await access.search.count("spans", {})).toBe(3);
      await access.close();
    }
    expect(probes).toBe(2); // One probe per client, reused for its subsequent queries.
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(borrowed[0]).toBe(borrowed[1]);
    expect(dispose).not.toHaveBeenCalled();
    await root.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    await root.dispose(); initialize.mockRestore(); connect.mockRestore(); dispose.mockRestore();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// @case Initialization and cleanup both fail: retain the original error and the cleanup owner's failure.
for (const ownership of ["local", "root"] as const) test(`access preserves connection and cleanup failures: ${ownership}`, async () => {
  const root = ownership === "root" ? new ClientManager() : undefined;
  const original = Object.assign(new TypeError("invalid TLS servername"), { code: "ERR_INVALID_ARG_VALUE" });
  const cleanup = new Error("fixture close failed");
  const initialize = spyOn(OpenSearchClient.prototype, "initialize").mockRejectedValue(original);
  const close = spyOn(OpenSearchClient.prototype, "close").mockRejectedValue(cleanup);
  try {
    const failure = await openOpenSearchAccess({ connection: { kind: "direct", endpoint: "https://search.invalid:9200" },
      auth: {}, clients: root }).catch(error => error);
    expect(failure).toBeInstanceOf(OpenSearchAccessError);
    expect(failure.cause).toBe(original);
    expect(failure.message).toBe(original.message);
    expect(failure.cleanupErrors).toEqual(root ? [] : [cleanup]);
    expect(close).toHaveBeenCalledTimes(1);
    if (root) await expect(root.dispose()).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await root?.dispose().catch(() => {});
    initialize.mockRestore(); close.mockRestore();
  }
});

// @case Caller cancellation releases the partial client without cancelling a borrowed root manager.
for (const ownership of ["local", "root"] as const) test(`access forwards explicit cancellation: ${ownership}`, async () => {
  const root = ownership === "root" ? new ClientManager() : undefined;
  const controller = new AbortController();
  const cancelled = new Error("fixture cancelled");
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const initialize = spyOn(OpenSearchClient.prototype, "initialize").mockImplementation(function (this: OpenSearchClient) {
    started();
    return new Promise((_resolve, reject) => {
      if (this.signal.aborted) reject(this.signal.reason);
      else this.signal.addEventListener("abort", () => reject(this.signal.reason), { once: true });
    });
  });
  const close = spyOn(OpenSearchClient.prototype, "close").mockResolvedValue();
  try {
    const pending = openOpenSearchAccess({ connection: { kind: "direct", endpoint: "https://search.invalid:9200" },
      auth: {}, clients: root, signal: controller.signal }).catch(error => error);
    await ready;
    controller.abort(cancelled);
    expect(await pending).toBe(cancelled);
    expect(close).toHaveBeenCalledTimes(1);
    if (root) expect(root.signal.aborted).toBe(false);
    await root?.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort(cancelled);
    await root?.dispose().catch(() => {});
    initialize.mockRestore(); close.mockRestore();
  }
});
