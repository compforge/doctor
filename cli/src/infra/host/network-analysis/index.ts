import type { ExecResult, RunOptions } from "../../k8s/executor";
import { runArgv } from "../../k8s/executor";
import { createGopacketBackend } from "./gopacket";
import { createTsharkBackend } from "./tshark";

export interface NetworkHttpHeader {
  name: string;
  value: string;
}

export interface NetworkHttpBody {
  base64: string;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
}

export interface NetworkFrameSummary {
  pod: string;
  timeEpoch?: number;
  source: string;
  destination: string;
  tcpStream?: number;
  http2Stream?: number;
  kind: "request" | "response" | "body" | "reset" | "finish" | "tls" | "other";
  method?: string;
  host?: string;
  path?: string;
  status?: number;
  httpVersion?: string;
  reasonPhrase?: string;
  headers: NetworkHttpHeader[];
  body?: NetworkHttpBody;
  matchedIds: string[];
  raw: string;
}

export interface PacketDecodeInput {
  pcap: string;
  pod: string;
  identifiers: readonly string[];
  timeoutMs?: number;
}

export interface PacketDecodeResult {
  backend: PacketAnalysisBackendName;
  frames: NetworkFrameSummary[];
}

export type PacketAnalysisBackendName = "tshark" | "gopacket";
export type CommandRunner = (argv: string[], opts?: RunOptions) => Promise<ExecResult>;

export interface PacketAnalysisBackend {
  readonly name: PacketAnalysisBackendName;
  inspect(): Promise<{ available: boolean; reason?: string }>;
  decode(input: PacketDecodeInput): Promise<NetworkFrameSummary[]>;
}

export interface NetworkAnalysisInfra {
  decodePcap(input: PacketDecodeInput): Promise<PacketDecodeResult>;
}

/**
 * Resolve the decoder once per analysis run. Wireshark stays the richer path when installed;
 * the bundled Go helper keeps the deterministic baseline independent of host packages.
 */
export function createNetworkAnalysisInfra(
  runner: CommandRunner = runArgv,
  injected?: readonly PacketAnalysisBackend[],
): NetworkAnalysisInfra {
  const backends = injected ?? [createTsharkBackend(runner), createGopacketBackend(runner)];
  let selected: Promise<PacketAnalysisBackend> | undefined;

  async function resolveBackend(): Promise<PacketAnalysisBackend> {
    const unavailable: string[] = [];
    for (const backend of backends) {
      const inspected = await backend.inspect();
      if (inspected.available) return backend;
      unavailable.push(`${backend.name}: ${inspected.reason ?? "不可用"}`);
    }
    throw new Error(`没有可用的 PCAP 解码器（${unavailable.join("；")}）`);
  }

  return {
    async decodePcap(input) {
      selected ??= resolveBackend();
      const backend = await selected;
      return { backend: backend.name, frames: await backend.decode(input) };
    },
  };
}

export const networkAnalysisInfra = createNetworkAnalysisInfra();
