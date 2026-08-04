import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";

export interface HttpEndpointTarget {
  scheme: "http" | "https";
  host: string;
  port: number;
}

export interface HttpEndpointInspection {
  reachable: boolean;
  phase: "dns" | "tcp";
  resolvedAddresses: readonly string[];
  remoteAddress?: string;
  durationMs: number;
  reason?: string;
}

export type InspectHttpEndpoint = (
  endpoint: HttpEndpointTarget,
  timeoutMs: number,
) => Promise<HttpEndpointInspection>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS lookup timeout after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function connect(host: string, port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const finish = (error?: Error) => {
      const remoteAddress = socket.remoteAddress;
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(remoteAddress);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`TCP connect timeout after ${timeoutMs} ms`)));
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

/** Local Inspect uses a direct DNS lookup and TCP handshake; no HTTP request is sent. */
export const inspectLocalHttpEndpoint: InspectHttpEndpoint = async (endpoint, timeoutMs) => {
  const started = Date.now();
  let addresses: string[];
  try {
    addresses = (await withTimeout(
      lookup(endpoint.host, { all: true }),
      timeoutMs,
    )).map((entry) => entry.address);
  } catch (error) {
    return {
      reachable: false,
      phase: "dns",
      resolvedAddresses: [],
      durationMs: Date.now() - started,
      reason: errorText(error),
    };
  }

  try {
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - started));
    const remoteAddress = await connect(endpoint.host, endpoint.port, remainingMs);
    return {
      reachable: true,
      phase: "tcp",
      resolvedAddresses: addresses,
      remoteAddress,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      reachable: false,
      phase: "tcp",
      resolvedAddresses: addresses,
      durationMs: Date.now() - started,
      reason: errorText(error),
    };
  }
};
