import type {
  CommandRunner,
  NetworkFrameSummary,
  PacketAnalysisBackend,
  PacketDecodeInput,
} from "..";

const TSHARK_FIELDS = [
  "frame.time_epoch", "ip.src", "ipv6.src", "tcp.srcport", "ip.dst", "ipv6.dst", "tcp.dstport",
  "tcp.stream", "http.request.method", "http.host", "http.request.uri", "http.response.code",
  "http.request.line", "http2.streamid", "http2.headers.method", "http2.headers.authority",
  "http2.headers.path", "http2.headers.status", "http2.header.name", "http2.header.value",
  "tcp.flags.reset", "tcp.flags.fin", "tls.handshake.type",
  "http.response.line", "http.request.full_uri", "http.file_data", "http2.data.data",
  "http.request.version", "http.response.version", "http.response.phrase",
] as const;

const FIELD_AGGREGATOR = "\u001f";
const MAX_HTTP_BODY_CAPTURE_BYTES = 64 * 1024;

function parseNumber(value: string): number | undefined {
  if (!value) return undefined;
  const number = Number(value.split(",")[0]);
  return Number.isFinite(number) ? number : undefined;
}

function first(left: string, right: string): string {
  return left || right;
}

function repeated(value: string): string[] {
  return value ? value.split(FIELD_AGGREGATOR).filter(Boolean) : [];
}

function headerLines(values: readonly string[]): Array<{ name: string; value: string }> {
  return values.flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator <= 0) return [];
    return [{
      name: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
    }];
  });
}

function http2Headers(names: string, values: string): Array<{ name: string; value: string }> {
  const headerNames = repeated(names);
  const headerValues = repeated(values);
  return headerNames.flatMap((name, index) =>
    name.startsWith(":") ? [] : [{ name, value: headerValues[index] ?? "" }]
  );
}

function capturedBody(...values: string[]): NetworkFrameSummary["body"] {
  const hex = values
    .flatMap(repeated)
    .join("")
    .replaceAll(":", "")
    .replaceAll(/\s/g, "");
  if (!hex || !/^[\da-f]+$/i.test(hex) || hex.length % 2 !== 0) return undefined;
  const bytes = Buffer.from(hex, "hex");
  const captured = bytes.subarray(0, MAX_HTTP_BODY_CAPTURE_BYTES);
  return {
    base64: captured.toString("base64"),
    capturedBytes: captured.byteLength,
    totalBytes: bytes.byteLength,
    truncated: captured.byteLength < bytes.byteLength,
  };
}

export function parseTsharkRows(raw: string, pod: string, identifiers: readonly string[]): NetworkFrameSummary[] {
  return raw.split(/\r?\n/).filter(Boolean).map((line) => {
    const values = line.split("\t");
    const field = (name: typeof TSHARK_FIELDS[number]) => values[TSHARK_FIELDS.indexOf(name)] ?? "";
    const method = first(field("http.request.method"), field("http2.headers.method"));
    const host = first(field("http.host"), field("http2.headers.authority"));
    const path = first(field("http.request.uri"), field("http2.headers.path"));
    const status = parseNumber(first(field("http.response.code"), field("http2.headers.status")));
    const reset = field("tcp.flags.reset") === "1";
    const finish = field("tcp.flags.fin") === "1";
    const tls = !!field("tls.handshake.type");
    const body = capturedBody(field("http.file_data"), field("http2.data.data"));
    const kind: NetworkFrameSummary["kind"] = method ? "request"
      : status !== undefined ? "response" : body ? "body"
        : reset ? "reset" : finish ? "finish" : tls ? "tls" : "other";
    const sourceIp = first(field("ip.src"), field("ipv6.src"));
    const destinationIp = first(field("ip.dst"), field("ipv6.dst"));
    const sourcePort = field("tcp.srcport");
    const destinationPort = field("tcp.dstport");
    const requestLines = repeated(field("http.request.line"));
    const responseLines = repeated(field("http.response.line"));
    const headers = [
      ...headerLines(kind === "request" ? requestLines : responseLines),
      ...http2Headers(field("http2.header.name"), field("http2.header.value")),
    ];
    if (kind === "request" && host && !headers.some((header) => header.name.toLowerCase() === "host")) {
      headers.unshift({ name: "Host", value: host });
    }
    return {
      pod,
      timeEpoch: parseNumber(field("frame.time_epoch")),
      source: `${sourceIp || "?"}:${sourcePort || "?"}`,
      destination: `${destinationIp || "?"}:${destinationPort || "?"}`,
      tcpStream: parseNumber(field("tcp.stream")),
      http2Stream: parseNumber(field("http2.streamid")),
      kind,
      method: method || undefined,
      host: host || undefined,
      path: path || undefined,
      status,
      httpVersion: first(field("http.request.version"), field("http.response.version")) || undefined,
      reasonPhrase: field("http.response.phrase") || undefined,
      headers,
      body,
      matchedIds: identifiers.filter((id) => line.includes(id)),
      raw: [...requestLines, ...responseLines].join("\r\n") || line,
    };
  });
}

function tsharkArgs(pcap: string): string[] {
  return [
    "tshark", "-r", pcap, "-Y",
    "http || http2 || tls.handshake || tcp.flags.reset == 1 || tcp.flags.fin == 1",
    "-T", "fields", "-E", "separator=/t", "-E", "occurrence=a",
    "-E", `aggregator=${FIELD_AGGREGATOR}`,
    ...TSHARK_FIELDS.flatMap((field) => ["-e", field]),
  ];
}

export function createTsharkBackend(runner: CommandRunner): PacketAnalysisBackend {
  return {
    name: "tshark",
    async inspect() {
      const result = await runner(["tshark", "--version"], { timeoutMs: 20_000 });
      return result.ok ? { available: true }
        : { available: false, reason: result.stderr.trim() || "未安装 tshark" };
    },
    async decode(input: PacketDecodeInput) {
      const result = await runner(tsharkArgs(input.pcap), { timeoutMs: input.timeoutMs ?? 10 * 60_000 });
      if (!result.ok) {
        const reason = result.stderr.trim().split("\n")[0] || `exit=${result.exitCode}`;
        throw new Error(`tshark 解析 ${input.pod} 失败：${reason}`);
      }
      return parseTsharkRows(result.stdout, input.pod, input.identifiers);
    },
  };
}
