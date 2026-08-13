import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  hostProcessToolkitChannel,
  resolveToolkitResource,
} from "../../../toolkit";
import type {
  CommandRunner,
  NetworkFrameSummary,
  PacketAnalysisBackend,
  PacketDecodeInput,
} from "..";

function assetName(): string {
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `doctor-pcap-${process.platform}-${arch}`;
}

/** Resolve the Host-process decoder from Toolkit, then adjacent files or PATH. */
export function resolveGopacketCommand(): string {
  const channel = hostProcessToolkitChannel();
  const packaged = channel
    ? resolveToolkitResource(channel, "tool", "doctor-pcap")
    : undefined;
  if (packaged) return packaged.path;
  const executableDir = dirname(process.execPath);
  const entryDir = dirname(process.argv[1] ?? process.execPath);
  const candidates = [
    join(executableDir, "doctor-pcap"),
    join(executableDir, assetName()),
    join(entryDir, "doctor-pcap"),
    join(entryDir, assetName()),
    join(process.cwd(), "toolkit", "dist", assetName()),
  ];
  return candidates.find(existsSync) ?? "doctor-pcap";
}

function parseFrame(line: string, pod: string): NetworkFrameSummary {
  const value = JSON.parse(line) as Partial<NetworkFrameSummary>;
  if (!value.kind || !value.source || !value.destination || !Array.isArray(value.matchedIds)) {
    throw new Error(`gopacket 返回了无效事件：${line.slice(0, 160)}`);
  }
  return {
    pod,
    source: value.source,
    destination: value.destination,
    kind: value.kind,
    headers: value.headers ?? [],
    matchedIds: value.matchedIds,
    raw: value.raw ?? "",
    timeEpoch: value.timeEpoch,
    tcpStream: value.tcpStream,
    http2Stream: value.http2Stream,
    method: value.method,
    host: value.host,
    path: value.path,
    status: value.status,
    httpVersion: value.httpVersion,
    reasonPhrase: value.reasonPhrase,
    body: value.body,
  };
}

export function createGopacketBackend(runner: CommandRunner): PacketAnalysisBackend {
  const command = resolveGopacketCommand();
  return {
    name: "gopacket",
    async inspect() {
      const result = await runner([command, "--version"], { timeoutMs: 20_000 });
      return result.ok ? { available: true }
        : { available: false, reason: result.stderr.trim() || "Toolkit doctor-pcap 不可用" };
    },
    async decode(input: PacketDecodeInput) {
      const argv = [command, "decode", "--input", input.pcap, "--pod", input.pod];
      for (const identifier of input.identifiers) argv.push("--identifier", identifier);
      const result = await runner(argv, { timeoutMs: input.timeoutMs ?? 10 * 60_000 });
      if (!result.ok) {
        const reason = result.stderr.trim().split("\n")[0] || `exit=${result.exitCode}`;
        throw new Error(`gopacket 解析 ${input.pod} 失败：${reason}`);
      }
      return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => parseFrame(line, input.pod));
    },
  };
}
