export interface OpenSearchService {
  namespace: string;
  name: string;
  port: number;
}

/** Discover one OpenSearch Service without embedding Plugin-specific service names. */
export function pickOpenSearchService(
  serviceJson: string,
  serviceName?: string,
  desiredPort?: number,
): { ok: true; value: OpenSearchService } | { ok: false; reason: string } {
  let items: Array<Record<string, any>>;
  try {
    items = (JSON.parse(serviceJson)?.items ?? []) as Array<Record<string, any>>;
  } catch (error) {
    return { ok: false, reason: `svc 列表 JSON 解析失败: ${String(error)}` };
  }

  const candidates: OpenSearchService[] = [];
  for (const item of items) {
    const name: string = item?.metadata?.name ?? "";
    if (serviceName ? name !== serviceName : !name.toLowerCase().includes("opensearch")) continue;
    // Explicit selection may target a headless Service; heuristic discovery skips its common twin.
    if (!serviceName && item?.spec?.clusterIP === "None") continue;
    const ports: number[] = (item?.spec?.ports ?? [])
      .map((port: Record<string, unknown>) => port?.port)
      .filter((port: unknown): port is number => Number.isInteger(port));
    const port = desiredPort
      ? ports.find((candidate) => candidate === desiredPort)
      : ports.includes(9200) ? 9200 : ports[0];
    if (!port) continue;
    candidates.push({ namespace: item?.metadata?.namespace ?? "", name, port });
  }
  if (!candidates.length) {
    return {
      ok: false,
      reason: serviceName
        ? `未找到 service '${serviceName}'${desiredPort ? ` 的端口 ${desiredPort}` : ""}`
        : "未发现名字含 opensearch 的 service；用 -n/--service 收窄，或 --endpoint 直连",
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `发现多个候选 service，请用 -n/--service 收窄：${candidates
        .map((candidate) => `${candidate.namespace}/${candidate.name}:${candidate.port}`)
        .join(", ")}`,
    };
  }
  return { ok: true, value: candidates[0]! };
}
