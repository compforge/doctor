import { S3Error } from "@compforge/harness-toolbox/s3";
import { forServices } from "../../command/services";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandInputError, CommandStatus, defineCommand } from "../../command";
import { prepareCommandRequirements } from "../../command/prepare";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { renderEvidence, writeEvidencePage } from "../../report/evidence";
import { canPrompt, inputParameter, ParameterCancelled } from "../../terminal/parameters";
import { useLogger } from "../../terminal/log";
import { EvidenceBundle } from "../evidence";
import { escapeHtml } from "../output/html";
import { serializeEvidenceResult } from "../serialize";
import { promptS3Request, validateS3Input, type S3Input, type S3Request } from "./input";
import { executeS3, type S3Result } from "./operations";
import { resolveS3Provider } from "./provider";
import { selectInspectProvider } from "./discovery";
import { inspectS3 } from "./inspect";
import { authorize } from "../operation";
import { resolveApprovalGate } from "../../terminal/approval";
import { defaultCommandReportName } from "../../command/report-name";
import { chunkBudget } from "./chunk";
import { s3Summary } from "./summary";

type PreparedS3 = { input: S3Input; request: S3Request };
const s3ServiceCommand = defineCommand<S3Input, void, PreparedS3>({
  name: "doctor s3",
  validate: validateS3Input,
  reportName: (input, _result, now) => {
    if (input.action !== "inspect") return undefined;
    return existsSync("s3-inspect.tar.gz") ? defaultCommandReportName("s3-inspect", [], now) : "s3-inspect";
  },
  serialize: serializeEvidenceResult,
  render: (context, result) => renderEvidence(context, result, {
    command: "s3", title: "S3 对象取证",
    render: artifact => writeEvidencePage(context, artifact, {
      title: "S3 对象取证", summaryHtml: `<pre>${escapeHtml(context.read(artifact, "summary.md"))}</pre>`,
    }),
  }),
  prepare: async (context, input) => {
    if (context.options.format?.trim() === "summary" && context.options.output) throw new CommandInputError("--format summary 直接输出到终端，不支持 --output");
    await prepareCommandRequirements(context, { plugin: { command: "doctor s3", needs: [{
      requirement: "required", capability: { scope: "resource", name: "dataSources" }, purpose: "解析 Service 的 S3 访问目标",
    }] } });
    let request: S3Request;
    try { request = await promptS3Request(input); }
    catch (error) {
      if (error instanceof ParameterCancelled) return undefined;
      throw error;
    }
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
      const provider = await (request.action === "inspect" ? selectInspectProvider : resolveS3Provider)(context, input, request);
      identity = provider.identity;
      if (request.action === "inspect") {
        const bucket = request.bucket ?? identity.configuredBucket ?? await inputParameter("bucket", canPrompt(input));
        if (!bucket || /[\s/?#\\]/.test(bucket)) throw new CommandInputError("无效的 bucket");
        request = { ...request, bucket };
        const endpoint = identity.endpoint;
        const inspection = await inspectS3(provider.client, request, provider.prepareWire, () =>
          authorize({ bundle, mode: "disrupt", approvals: new Map(), approvalGate: resolveApprovalGate(input) }, {
            id: "s3-chunk-upload", risk: "disrupt", title: "探测 S3 上传 chunk 上限",
            target: endpoint + " · s3://" + bucket + "/doctor-probe/",
            impact: [`最多 ${chunkBudget.attempts} 次 PUT，数据合计最多 ${chunkBudget.bytes / 1024 ** 2} MiB，逐次清理唯一临时对象`], steps: [],
          }));
        result = { entries: [], pages: 0, complete: !Object.keys(inspection.errors).length, inspection };
      } else result = await executeS3(provider.client, request);
      if (!result.complete) {
        status = result.entries.length || result.bytes ? CommandStatus.Partial : result.failure || result.stoppedReason === "time-limit" ? CommandStatus.Failed : CommandStatus.Partial;
        reason = result.failure?.message ?? result.stoppedReason ?? Object.values(result.inspection?.errors ?? {}).join("；");
      }
      const { bytes, ...observation } = result;
      if (bytes) writeFileSync(join(directory, "content.bin"), bytes, { mode: 0o600 });
      const path = join(directory, "result.json");
      writeFileSync(path, JSON.stringify({ ...observation, bytesRead: bytes?.byteLength, contentFile: bytes ? "content.bin" : undefined }, null, 2), { mode: 0o600 });
      // Evidence moves raw files; use its recorded path in the public diagnosis index.
      resultFile = bundle.addStep({ id: request.action, title: `S3 ${request.action}`, risk: request.action === "inspect" ? "disrupt" : "observe", status, reason, rawFilePath: path, ext: "json" }).raw_file;
    } catch (error) {
      status = error instanceof ParameterCancelled || context.signal.aborted ? CommandStatus.Cancelled : CommandStatus.Failed;
      reason = status === CommandStatus.Cancelled ? "操作已取消" : error instanceof CommandInputError ? error.message : S3Error.from(error).message;
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

export const s3Command = forServices(s3ServiceCommand);
