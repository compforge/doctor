import type { HttpAttemptObservation, HttpRequestPlan } from "./model";

export interface HttpFailureDiagnosis {
  kind: "dns" | "proxy-dns" | "connect" | "timeout" | "tls-certificate" | "tls-handshake" | "scheme-mismatch" | "http-status" | "transfer" | "unknown";
  certainty: "observed" | "suspected";
  summary: string;
  hint: string;
}

/** Classify the observed failure; connection timeouts and TLS failures are not proof of a particular network policy or scheme. */
export function diagnoseHttpFailure(request: HttpRequestPlan, observation: HttpAttemptObservation, bodyPreview = ""): HttpFailureDiagnosis | undefined {
  const response = observation.response;
  const transport = response.transport;
  const code = transport?.exitCode;
  const error = `${response.error ?? ""} ${transport?.error ?? ""}`;
  const observed = (kind: HttpFailureDiagnosis["kind"], summary: string, hint: string): HttpFailureDiagnosis => ({ kind, certainty: "observed", summary, hint });
  if (code === 5) return observed("proxy-dns", "代理域名解析失败", "检查消费方 Pod 的代理配置与 DNS；这不是目标域名解析失败的证据。");
  if (code === 6 || /Could not resolve host|ENOTFOUND|EAI_AGAIN/i.test(error)) return observed("dns", "目标域名解析失败", "检查该 Pod 的 DNS、搜索域与域名拼写；尚未建立到目标的连接。");
  if (code === 60 || code === 51 || /certificate verify failed|self.signed certificate|unable to get local issuer|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED/i.test(error)) {
    return observed("tls-certificate", "TLS 证书校验失败", "检查证书链、域名匹配、有效期与 Pod 信任根；保留证书校验，不自动跳过。");
  }
  if (request.url.startsWith("https:") && /wrong version number|unknown protocol|record layer failure|packet length too long/i.test(error)) {
    return { kind: "scheme-mismatch", certainty: "suspected", summary: "疑似把 HTTP 地址配置成 HTTPS", hint: "TLS 收到了不符合预期的记录；核对 URL scheme、端口、代理和入口 TLS 配置。该错误本身不足以证明服务只支持 HTTP。" };
  }
  if (code === 35 || /SSL.*(?:handshake|connect)|TLS.*handshake|EPROTO/i.test(error)) return observed("tls-handshake", "TLS 握手失败", "核对 scheme、端口、TLS 版本与代理；不能仅凭握手失败认定 HTTP/HTTPS 配错。");
  if (code === 7 || /ECONNREFUSED|No route to host|Network is unreachable/i.test(error)) return observed("connect", "连接目标失败", "检查目标 IP/端口、监听、路由、NetworkPolicy 和防火墙；连接失败不单独证明是哪一项配置有误。");
  if (code === 28 || response.terminationReason === "doctor_timeout" || /ETIMEDOUT|timed out|timeout/i.test(error)) return observed("timeout", "请求超时", "结合目标 IP、各阶段耗时及是否收到 HTTP 状态判断卡在哪一阶段；超时不能单独证明 DNS 或网络策略故障。");
  if (request.url.startsWith("http:") && response.statusCode === 400 && /plain HTTP request was sent to HTTPS port|client sent an HTTP request to an HTTPS server/i.test(bodyPreview)) {
    return observed("scheme-mismatch", "服务端明确要求 HTTPS，但请求使用 HTTP", "核对配置中的 scheme 与端口；报告保留原始 400 响应，不自动换协议重试。");
  }
  if (response.statusCode !== undefined && !request.expect.status.includes(response.statusCode)) {
    return observed("http-status", `已收到 HTTP ${response.statusCode}，与 Case 预期不符`, "已收到服务器或代理的 HTTP 响应；结合响应正文区分鉴权、路由和业务错误，不能归为域名不可达。");
  }
  if (!response.captureComplete) {
    if ([18, 52, 55, 56].includes(code ?? -1)) return observed("transfer", "连接关闭或响应传输失败", "检查原始错误及已接收的响应，可能涉及对端重置、代理或响应中断。");
    return observed("unknown", "请求或响应采集未完成", "当前证据不足以定位网络层原因；查看原始错误、退出码及采集终止原因。");
  }
  return undefined;
}
