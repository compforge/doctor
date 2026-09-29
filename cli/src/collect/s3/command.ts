import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandInputError, CommandStatus, defineCommand } from "../../command";
import { prepareCommandRequirements } from "../../command/prepare";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { renderEvidence, writeEvidencePage } from "../../report/evidence";
import { ParameterCancelled } from "../../terminal/parameters";
import { useLogger } from "../../terminal/log";
import { EvidenceBundle } from "../evidence";
import { escapeHtml } from "../output/html";
import { serializeEvidenceResult } from "../serialize";
import { resolveS3Request, type S3Input, type S3Request } from "./input";
import { executeS3, s3Failure, type S3Result } from "./operations";
import { resolveS3Provider } from "./provider";
import { s3Summary } from "./summary";

type PreparedS3 = { input: S3Input; request: S3Request };
export const s3Command = defineCommand<S3Input, void, PreparedS3>({
  name: "doctor s3",
  validate: input => { resolveS3Request(input); },
  serialize: serializeEvidenceResult,
  render: (context, result) => renderEvidence(context, result, {
    command: "s3", title: "S3 对象取证",
    render: artifact => writeEvidencePage(context, artifact, {
      title: "S3 对象取证", summaryHtml: `<pre>${escapeHtml(context.read(artifact, "summary.md"))}</pre>`,
    }),
  }),
  prepare: async (context, input) => {
    const request = resolveS3Request(input);
    if (context.options.format?.trim() === "summary" && context.options.output) throw new CommandInputError("--format summary 直接输出到终端，不支持 --output");
    await prepareCommandRequirements(context, { plugin: { command: "doctor s3", needs: [{
      requirement: "required", capability: { scope: "resource", name: "dataSources" }, purpose: "解析 Service 的 S3 访问目标",
    }] } });
    return { input, request };
  },
  run: async (context, { input, request }) => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-s3-"));
    const bundle = new EvidenceBundle(directory);
    context.artifacts.add({ command: "s3", path: directory });
    const startedAt = new Date().toISOString();
    let identity: Awaited<ReturnType<typeof resolveS3Provider>>["identity"] | undefined;
    let result: S3Result | undefined;
    let resultFile: string | undefined;
    let status = CommandStatus.Ok;
    let reason: string | undefined;
    try {
      const provider = await resolveS3Provider(context, input, request);
      identity = provider.identity;
      result = await executeS3(provider.client, request);
      if (!result.complete) {
        status = result.entries.length || result.bytes ? CommandStatus.Partial : result.failure || result.stoppedReason === "time-limit" ? CommandStatus.Failed : CommandStatus.Partial;
        reason = result.failure?.reason ?? result.stoppedReason;
      }
      const { bytes, ...observation } = result;
      if (bytes) writeFileSync(join(directory, "content.bin"), bytes, { mode: 0o600 });
      const path = join(directory, "result.json");
      writeFileSync(path, JSON.stringify({ ...observation, bytesRead: bytes?.byteLength, contentFile: bytes ? "content.bin" : undefined }, null, 2), { mode: 0o600 });
      // Evidence moves raw files; use its recorded path in the public diagnosis index.
      resultFile = bundle.addStep({ id: request.action, title: `S3 ${request.action}`, risk: "observe", status, reason, rawFilePath: path, ext: "json" }).raw_file;
    } catch (error) {
      status = error instanceof ParameterCancelled || context.signal.aborted ? CommandStatus.Cancelled : CommandStatus.Failed;
      reason = status === CommandStatus.Cancelled ? "操作已取消" : error instanceof CommandInputError ? error.message : s3Failure(error).reason;
      bundle.addStep({ id: "operation", title: `S3 ${request.action}`, risk: "observe", status: "failed", reason });
    }
    const summary = s3Summary(request, result, identity, reason);
    bundle.writeSummary(summary);
    bundle.writeCollection({ doctorVersion: DOCTOR_CLI_VERSION, target: identity ?? { service: request.service },
      inspectionFacts: identity ?? {}, params: { ...request, dataSource: input.dataSource },
      startedAt, finishedAt: new Date().toISOString() });
    writeFileSync(join(directory, "diagnosis.json"), JSON.stringify({ status, reason, target: identity,
      request, resultFile }, null, 2), { mode: 0o600 });
    if (context.options.format?.trim() !== "summary") useLogger("s3").info(summary);
    return { status, reason, output: undefined, artifacts: context.artifacts.list() };
  },
});
