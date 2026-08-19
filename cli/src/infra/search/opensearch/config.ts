import { OpenSearchEngine, type OpenSearchAuth } from "./client";

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
    ?? ((node: string) => new OpenSearchEngine({ node, auth, requestTimeoutMs: 5_000 }));
  for (const scheme of schemes) {
    const node = `${scheme}://${hostPort}`;
    const engine = createEngine(node);
    try {
      await engine.ping();
      return node;
    } catch (error) {
      const status = statusCode(error);
      if (status !== undefined && ![502, 503, 504].includes(status)) return node;
    } finally {
      await engine.close?.();
    }
  }
  throw new Error(`OpenSearch 不可达（http/https 均探测失败）: ${hostPort}`);
}
