export interface ParsedOpenSearchEndpoint {
  url: string;
  safeUrl: string;
  safeEndpoint: string;
  host: string;
  port: number;
  scheme: "http" | "https";
  schemeExplicit: boolean;
  username?: string;
  password?: string;
}

/**
 * 连接串只在执行态保留 userinfo；任何可记录的 endpoint 必须使用 safeUrl。
 * OPENSEARCH_ENDPOINTS 常见为逗号分隔，这里选择第一个节点作为稳定访问入口。
 */
export function parseOpenSearchEndpoint(value: string): ParsedOpenSearchEndpoint {
  const first = value.split(",").map((item) => item.trim()).find(Boolean);
  if (!first) throw new Error("OpenSearch endpoint 为空");
  const schemeExplicit = first.includes("://");
  let parsed: URL;
  try {
    parsed = new URL(schemeExplicit ? first : `http://${first}`);
  } catch {
    throw new Error(`OpenSearch endpoint 格式无效：${first}`);
  }
  if (!parsed.hostname) throw new Error(`OpenSearch endpoint 缺少 host：${first}`);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`OpenSearch endpoint scheme 仅支持 http/https：${parsed.protocol}`);
  }
  const scheme = parsed.protocol.slice(0, -1) as "http" | "https";
  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  const port = parsed.port
    ? Number(parsed.port)
    : schemeExplicit ? scheme === "https" ? 443 : 80 : 9200;
  parsed.username = "";
  parsed.password = "";
  parsed.port = String(port);
  parsed.pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  const safeUrl = parsed.toString().replace(/\/$/, "");
  const safeEndpoint = schemeExplicit ? safeUrl : `${parsed.hostname}:${port}`;
  return {
    url: safeUrl,
    safeUrl,
    safeEndpoint,
    host: parsed.hostname,
    port,
    scheme,
    schemeExplicit,
    username,
    password,
  };
}
