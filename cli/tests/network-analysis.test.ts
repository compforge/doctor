import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { analyzeNetworkBundle, runAnalyzeNetwork } from "../src/collect/network";
import {
  buildNetworkAnalysisHtml,
  buildNetworkAnalysisInspector,
} from "../src/collect/network/analysis/render";
import type { ExecResult } from "../src/infra/k8s/executor";
import { createNetworkAnalysisInfra } from "../src/infra/host/network-analysis";

function result(command: string[], input: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command,
    ...input,
  };
}

function row(fields: Record<number, string>): string {
  const values = Array.from({ length: 31 }, () => "");
  for (const [index, value] of Object.entries(fields)) values[Number(index)] = value;
  return values.join("\t");
}

test("doctor neta 按染色 ID 选择 TCP stream，并区分 HTTP 499 与 RST", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-neta-test-"));
  const pcap = Buffer.from("fake-pcap");
  const pcapPath = join(root, "capture.pcap");
  writeFileSync(pcapPath, pcap);
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    target: {
      namespace: "default",
      services: ["frontend"],
      capture_id: "doctor-test",
      trace_ids: ["trace-1"],
    },
    params: {
      capture_mode: "tracking",
    },
    inspection_facts: {
      topology: {
        services: [{
          name: "frontend",
          clusterIp: "10.96.0.10",
          ports: [8000],
          pods: ["chat-0"],
        }],
        targets: [{
          pod: "chat-0",
          podIp: "10.0.0.2",
          services: ["frontend"],
        }],
      },
      capture_artifacts: [{
        pod: "chat-0",
        services: ["frontend"],
        file: "capture.pcap",
        sha256: createHash("sha256").update(pcap).digest("hex"),
        verified: true,
        window_complete: true,
      }],
    },
  }));
  const requestBody = JSON.stringify({ message: "hi" });
  const responseBody = JSON.stringify({ error: "closed" });
  const tsharkOutput = [
    row({
      0: "1.000",
      1: "10.0.0.1",
      3: "12345",
      4: "10.0.0.2",
      6: "8000",
      7: "7",
      8: "POST",
      9: "frontend",
      10: "/api/chat",
      12: [
        "X-Doctor-Capture-ID: doctor-test",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(requestBody)}`,
      ].join("\u001f"),
      27: "HTTP/1.1",
    }),
    row({
      0: "1.100",
      1: "10.0.0.1",
      3: "12345",
      4: "10.0.0.2",
      6: "8000",
      7: "7",
      25: Buffer.from(requestBody).toString("hex"),
    }),
    row({
      0: "2.000",
      1: "10.0.0.2",
      3: "8000",
      4: "10.0.0.1",
      6: "12345",
      7: "7",
      11: "499",
      23: [
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(responseBody)}`,
      ].join("\u001f"),
      28: "HTTP/1.1",
      29: "Client Closed Request",
    }),
    row({
      0: "2.050",
      1: "10.0.0.2",
      3: "8000",
      4: "10.0.0.1",
      6: "12345",
      7: "7",
      25: Buffer.from(responseBody).toString("hex"),
    }),
    row({ 0: "2.100", 1: "10.0.0.1", 3: "12345", 4: "10.0.0.2", 6: "8000", 7: "7", 20: "1" }),
  ].join("\n");
  const runner = async (argv: string[]) =>
    argv[0] === "tshark" && argv[1] === "--version"
      ? result(argv, { stdout: "TShark 4.4\n" })
      : result(argv, { stdout: tsharkOutput });
  const dependencies = {
    runner,
    packetAnalysis: createNetworkAnalysisInfra(runner),
  };
  const analyzed = await analyzeNetworkBundle(root, {}, dependencies);

  expect(analyzed.analysis.schema).toBe("doctor.net.analysis/v4");
  expect(analyzed.analysis.summary.matchedStreamCount).toBe(1);
  expect(analyzed.analysis.summary.hopCount).toBe(1);
  expect(analyzed.analysis.analyzer.decoder).toBe("tshark");
  expect(analyzed.analysis.diagnosis.findings.map((finding) => finding.kind))
    .toEqual(["network.http-error", "network.connection-reset"]);
  expect(analyzed.analysis.diagnosis.coverage).toContainEqual({
    goal: "capture-scope",
    status: "sufficient",
    missingEvidence: [],
  });
  expect(analyzed.markdown).toContain("frontend 的 POST /api/chat 在报文中返回 HTTP 499");
  expect(analyzed.markdown).toContain("## 抓包覆盖矩阵");
  expect(analyzed.markdown).toContain("“未观察到”不等于“下游未收到”");
  const hop = analyzed.analysis.diagnosis.evidence.observations.find(
    (observation) => observation.kind === "network.http-hop",
  );
  expect(hop?.request.headers).toContainEqual({ name: "Content-Type", value: "application/json" });
  expect(Buffer.from(hop?.request.body?.base64 ?? "", "base64").toString()).toBe(requestBody);
  expect(hop?.response?.reasonPhrase).toBe("Client Closed Request");
  expect(Buffer.from(hop?.response?.body?.base64 ?? "", "base64").toString()).toBe(responseBody);
  const html = buildNetworkAnalysisHtml(analyzed.analysis);
  expect(html).toContain("业务调用泳道");
  expect(html).toContain('aria-label="业务调用泳道图"');
  expect(html).toContain("调用时间瀑布");
  expect(html.match(/data-inspector-id=/g)?.length).toBe(2);
  expect(html).toContain("cURL 只是 Request 的一种展示形态");
  expect(html).toContain("frontend");
  const inspector = buildNetworkAnalysisInspector(analyzed.analysis);
  expect(inspector).toContain("Request");
  expect(inspector).toContain("Response");
  expect(inspector).toContain("Preview");
  expect(inspector).toContain("复制 cURL");
  expect(inspector).toContain("HTTP/1.1 499 Client Closed Request");
  expect(inspector).toContain("HTTP 499");
  expect(inspector).toContain("application/json");

  const limitedManifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));
  limitedManifest.inspection_facts.capture_artifacts[0].window_complete = false;
  limitedManifest.inspection_facts.capture_artifacts[0].reason =
    "达到容量上限后提前停止；停止后的流量缺失";
  writeFileSync(join(root, "manifest.json"), JSON.stringify(limitedManifest));
  const limited = await analyzeNetworkBundle(root, {}, dependencies);
  expect(limited.analysis.diagnosis.coverage).toContainEqual({
    goal: "capture-scope",
    status: "insufficient",
    missingEvidence: ["chat-0: 达到容量上限后提前停止；停止后的流量缺失"],
  });

  const reportBase = join(root, "report");
  expect(await runAnalyzeNetwork(root, { output: reportBase }, dependencies)).toBe(0);
  expect(existsSync(`${reportBase}.md`)).toBe(true);
  expect(existsSync(`${reportBase}.json`)).toBe(true);
  expect(existsSync(`${reportBase}.html`)).toBe(true);
  const reportHtml = readFileSync(`${reportBase}.html`, "utf-8");
  expect(reportHtml).toContain("业务调用泳道图");
  expect(reportHtml).toContain('class="report-layout"');
  expect(reportHtml).toContain('<aside class="report-inspector" role="dialog" aria-modal="false" aria-label="HTTP 请求详情" hidden>');
  expect(reportHtml).toContain("data-inspector-template=");
  expect(reportHtml).toContain("selectInspector");
  expect(reportHtml).toContain("activateExchangeTab");

  expect(await runAnalyzeNetwork(root, {
    output: join(root, "decode-failed"),
  }, {
    runner,
    packetAnalysis: {
      decodePcap: async () => {
        throw new Error("decoder unavailable");
      },
    },
  })).toBe(1);
});

test("PCAP decoder 在 tshark 不可用时回退到内置 gopacket helper", async () => {
  const commands: string[][] = [];
  const runner = async (argv: string[]) => {
    commands.push(argv);
    if (argv[0] === "tshark") return result(argv, { ok: false, exitCode: null, stderr: "not found" });
    if (argv[1] === "--version") return result(argv, { stdout: "doctor-pcap 0.2.0\n" });
    return result(argv, { stdout: `${JSON.stringify({
      pod: "chat-0",
      timeEpoch: 1,
      source: "10.0.0.1:1",
      destination: "10.0.0.2:2",
      tcpStream: 0,
      kind: "request",
      method: "POST",
      path: "/api/chat",
      matchedIds: ["doctor-test"],
      raw: "X-Doctor-Capture-ID: doctor-test",
    })}\n` });
  };
  const decoded = await createNetworkAnalysisInfra(runner).decodePcap({
    pcap: "/tmp/capture.pcap",
    pod: "chat-0",
    identifiers: ["doctor-test"],
  });

  expect(decoded.backend).toBe("gopacket");
  expect(decoded.frames[0]?.matchedIds).toEqual(["doctor-test"]);
  expect(commands.some((argv) => argv[0] === "tshark" && argv[1] === "--version")).toBe(true);
  expect(commands.some((argv) => argv[1] === "decode")).toBe(true);
});

test("doctor neta 对守候模式 NetBundle 重建窗口内的可见 HTTP 请求", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-neta-listen-test-"));
  const pcap = Buffer.from("fake-listen-pcap");
  writeFileSync(join(root, "capture.pcap"), pcap);
  const manifest = {
    target: {
      namespace: "default",
      services: ["frontend"],
      capture_id: "doctor-listen-session",
      trace_ids: [],
    },
    params: {
      capture_mode: "watch",
    },
    inspection_facts: {
      topology: {
        services: [{
          name: "frontend",
          clusterIp: "10.96.0.10",
          ports: [8000],
          pods: ["chat-0"],
        }],
        targets: [{
          pod: "chat-0",
          podIp: "10.0.0.2",
          services: ["frontend"],
        }],
      },
      capture_artifacts: [{
        pod: "chat-0",
        services: ["frontend"],
        file: "capture.pcap",
        sha256: createHash("sha256").update(pcap).digest("hex"),
        verified: true,
        window_complete: true,
      }],
    },
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  const tsharkOutput = [
    row({
      0: "1.000",
      1: "10.0.0.1",
      3: "12345",
      4: "10.0.0.2",
      6: "8000",
      7: "3",
      8: "POST",
      9: "frontend",
      10: "/api/chat",
    }),
    row({ 0: "1.050", 1: "10.0.0.2", 3: "8000", 4: "10.0.0.1", 6: "12345", 7: "3", 11: "200" }),
  ].join("\n");
  const runner = async (argv: string[]) =>
    argv[0] === "tshark" && argv[1] === "--version"
      ? result(argv, { stdout: "TShark 4.4\n" })
      : result(argv, { stdout: tsharkOutput });

  const analyzed = await analyzeNetworkBundle(root, {}, {
    runner,
    packetAnalysis: createNetworkAnalysisInfra(runner),
  });

  expect(analyzed.analysis.config.mode).toBe("watch");
  expect(analyzed.analysis.diagnosis.evidence.facts).not.toHaveProperty("captureMode");
  expect(analyzed.analysis.diagnosis.evidence.facts.identifiers).toEqual([]);
  expect(analyzed.analysis.summary.hopCount).toBe(1);
  expect(analyzed.analysis.diagnosis.coverage.find((item) => item.goal === "request-correlation")?.status)
    .toBe("sufficient");
  expect(analyzed.markdown).toContain("- 采集模式: 守候");
  expect(analyzed.markdown).toContain("POST /api/chat");
});
