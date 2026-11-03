import { describeOpenSearchError, OpenSearchEngine, type OpenSearchAuth } from "@compforge/harness-toolbox/opensearch/client";

const USER_KEYS = ["DOCTOR_OPENSEARCH_USER", "DOCTOR_OPENSEARCH_USERNAME"];
const PASS_KEYS = ["DOCTOR_OPENSEARCH_PASSWORD"];

export function resolveOpenSearchAuth(
  username?: string,
  password?: string,
  env: Record<string, string | undefined> = process.env,
): OpenSearchAuth {
  if (username && password) return { username, password };
  const envUser = USER_KEYS.map((key) => env[key]?.trim()).find(Boolean);
  const envPass = PASS_KEYS.map((key) => env[key]?.trim()).find(Boolean);
  if (envUser && envPass) return { username: envUser, password: envPass };
  return {};
}

/** host[:port] without a scheme is probed; an explicit scheme is trusted. */
export function normalizeOpenSearchHost(value: string): { url?: string; hostPort?: string } {
  const normalized = value.trim().replace(/\/+$/, "");
  if (normalized.includes("://")) return { url: normalized };
  return { hostPort: /:\d+$/.test(normalized) ? normalized : `${normalized}:9200` };
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { statusCode?: unknown; meta?: { statusCode?: unknown } };
  const status = value.statusCode ?? value.meta?.statusCode;
  return typeof status === "number" ? status : undefined;
}

export interface OpenSearchProbeOptions {
  preferredScheme?: "http" | "https";
  signal?: AbortSignal;
  onDiagnostic?: (line: string) => void;
  createEngine?: (
    node: string,
  ) => Pick<OpenSearchEngine, "ping"> & Partial<Pick<OpenSearchEngine, "close">>;
}

/** Probe HTTP/HTTPS with the official client; auth errors still prove the node is reachable. */
export async function probeOpenSearchUrl(
  hostPort: string,
  auth: OpenSearchAuth,
  options: OpenSearchProbeOptions = {},
): Promise<string> {
  const schemes: Array<"http" | "https"> = options.preferredScheme === "https"
    ? ["https", "http"]
    : ["http", "https"];
  const createEngine = options.createEngine
    ?? ((node: string) => new OpenSearchEngine({ node, auth, requestTimeoutMs: 5_000, onDiagnostic: options.onDiagnostic }));
  const failures: string[] = [];
  for (const scheme of schemes) {
    options.signal?.throwIfAborted();
    const node = `${scheme}://${hostPort}`;
    const engine = createEngine(node);
    try {
      await engine.ping(options.signal, 5_000);
      return node;
    } catch (error) {
      options.signal?.throwIfAborted();
      const reason = `${scheme}: ${describeOpenSearchError(error)}`;
      failures.push(reason);
      options.onDiagnostic?.(`OpenSearch scheme probe failed ${reason}`);
      const status = statusCode(error);
      if (status !== undefined && ![502, 503, 504].includes(status)) return node;
    } finally {
      try { await engine.close?.(); }
      catch (error) { options.onDiagnostic?.(`OpenSearch probe cleanup failed ${describeOpenSearchError(error)}`); }
    }
  }
  throw new Error(`OpenSearch 不可达（http/https 均探测失败）: ${hostPort}; ${failures.join("; ")}`);
}
