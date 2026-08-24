import { createHmac } from "node:crypto";

export interface MinioMetricsCredentials {
  accessKey: string;
  secretKey: string;
}

export interface PrometheusSample {
  metric: string;
  labels: string;
  value: number;
}

export function prometheusLabel(labels: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|,)${name}="((?:\\\\.|[^"])*)"`).exec(labels);
  return match?.[1]
    ?.replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

export function parsePrometheusSample(line: string): PrometheusSample | undefined {
  const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+([^\s]+)(?:\s|$)/.exec(line.trim());
  if (!match) return undefined;
  const value = Number(match[3]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return { metric: match[1]!, labels: match[2]!, value };
}

function prometheusBearerToken(credentials: MinioMetricsCredentials): string {
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  const header = encode(JSON.stringify({ alg: "HS512", typ: "JWT" }));
  const payload = encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 60 * 60,
    sub: credentials.accessKey,
    iss: "prometheus",
  }));
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha512", credentials.secretKey).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

export async function requestMinioMetrics(input: {
  endpoint: string;
  path: string;
  credentials?: MinioMetricsCredentials;
  signal: AbortSignal;
}): Promise<{ endpoint: string; status: number; body: string }> {
  const metricsUrl = new URL(input.path, input.endpoint.endsWith("/") ? input.endpoint : `${input.endpoint}/`);
  let response = await fetch(metricsUrl, { signal: input.signal });
  if ((response.status === 401 || response.status === 403) && input.credentials) {
    response = await fetch(metricsUrl, {
      headers: { authorization: `Bearer ${prometheusBearerToken(input.credentials)}` },
      signal: input.signal,
    });
  }
  return {
    endpoint: metricsUrl.pathname,
    status: response.status,
    body: response.ok ? await response.text() : "",
  };
}
