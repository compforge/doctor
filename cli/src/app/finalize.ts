import { renderBundleAgents } from "./bundle-agents";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandContext, type CommandInput, type CommandResult, type Command } from "../command";
import { SerializeContext } from "../command/serialization/context";
import { RenderContext } from "../report/context";
import { renderReportHtml } from "../report/html";
import { cleanupTemporaryArtifacts, type CommandDeliveryOptions } from "./delivery";
import { deliverSerialized } from "./delivery";
import { kubernetesTargetRecord } from "../command/kubernetes-target";
import { reportError } from "./error-log";

export interface FinalizeCommandInput<Input extends CommandInput, Output> {
  spec: Command<Input, Output>;
  result: CommandResult<Output>;
  context: CommandContext;
  delivery: CommandDeliveryOptions;
  code: number;
}

/** @spec Root finalize serializes every result before optional local rendering and one delivery. */
export async function finalizeCommand<Input extends CommandInput, Output>(input: FinalizeCommandInput<Input, Output>): Promise<number> {
  let code = input.code;
  try { await input.context.disposeClients(); }
  catch (error) { reportError(error, { context: input.spec.name, summary: "client cleanup failed" }); code = 1; }
  if (input.context.signal.aborted) code = 130;
  // Non-reporting commands have no file output unless explicitly requested.
  if (!input.result.artifacts.length && input.result.output === undefined && input.delivery.format !== "manifest") return code;
  const directory = mkdtempSync(join(tmpdir(), "doctor-result-"));
  const serialized = await SerializeContext.create(directory, input.spec, input.result,
    (error, command) => reportError(error, { context: command, summary: "result serialization failed" }));
  if (serialized.failed && code !== 130) code = 1;
  const renderer = new RenderContext(serialized.artifacts, input.context.profile.name,
    (error, command) => reportError(error, { context: command, summary: "report render failed" }));
  const wantsReport = !["json", "md", "manifest"].includes(input.delivery.format?.trim() ?? "");
  if (wantsReport && input.spec.render) {
    try {
      const report = await renderer.render(input.spec, input.result);
      if (report.sections.length) writeFileSync(join(directory, "report.html"), renderReportHtml(report, renderer), { mode: 0o600 });
    } catch (error) { renderer.failed(input.spec.name, error); }
  }
  if (renderer.failures.length && code !== 130) code = 1;
  serialized.annotate({
    source: { profile: input.context.profile.name, plugin: input.context.pluginIdentity,
      targets: input.context.records(kubernetesTargetRecord, []) },
    render: { status: renderer.failures.length ? "failed" : "ok",
      errors: renderer.failures.map(item => ({ command: item.command, reason: String(item.error) })) },
    ...(serialized.failed ? { retained_artifacts: input.result.artifacts } : {}),
  });
  serialized.writeText("AGENTS.md", renderBundleAgents());
  serialized.indexReports();
  const delivered = await deliverSerialized({ directory, options: input.delivery, code,
    reportName: input.result.reportName ?? input.context.artifacts.reportName() ?? `doctor-${input.spec.name.replace(/^doctor\s+/, "").replaceAll(" ", "-")}` });
  if (delivered && code === 0 && !serialized.failed && !renderer.failures.length) {
    cleanupTemporaryArtifacts(input.context.artifacts.list().map(artifact => artifact.path));
  }
  return input.context.signal.aborted ? 130 : delivered ? code : 1;
}
