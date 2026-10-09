import {
  validateCaseProduceResult,
  type HealthCaseBinding, type CaseProduceResult, type CaseProduceExtension, type CaseProduceQuery,
  type ServiceDefinition, type WorkloadInstance,
} from "@compforge/doctor-plugin";
import type { SendHttp } from "../infra/http";
import { approvalDeniedReason, type ApprovalDecision } from "../command/approval";
import type { PreparedCaseCheck } from "./case-prepare";
import { caseError, checkHttpCase, type CaseAttempt } from "../case/http-check";

export interface CaseCheckResult {
  consumeExtension: string;
  bindingId?: string;
  consumer: string;
  producer?: HealthCaseBinding["producer"];
  workload?: string;
  startedAt: string;
  finishedAt?: string;
  stage: "consume" | "binding" | "identity" | "execution" | "provider" | "approval" | "request";
  status: "passed" | "failed" | "unavailable" | "empty" | "cancelled";
  error?: string;
  truncated?: string;
  targets: WorkloadInstance[];
  attempts: CaseAttempt[];
}

export interface CaseCheckActions {
  signal: AbortSignal;
  directory: string;
  /** Core prepares each target independently; one missing curl cannot hide another replica's result. */
  targets(service: ServiceDefinition, binding: HealthCaseBinding): Promise<{ targets: WorkloadInstance[]; truncated?: string }>;
  sender(target: WorkloadInstance): Promise<SendHttp>;
  approve(target: WorkloadInstance, item: CaseProduceResult["cases"][number]): Promise<ApprovalDecision>;
  produce(service: ServiceDefinition, extension: CaseProduceExtension, query: CaseProduceQuery): Promise<CaseProduceResult>;
  checkpoint(result: CaseCheckResult): void;
}

/** @spec Run only prepared dependencies; per-target Case generation remains fresh and authorization remains explicit. */
export async function checkServiceCases(prepared: readonly PreparedCaseCheck[], actions: CaseCheckActions): Promise<CaseCheckResult[]> {
  const results: CaseCheckResult[] = [];
  for (const check of prepared) {
    const { result, execution } = check;
    results.push(result);
    if (!execution) { actions.checkpoint(result); continue; }
    const { consumer, binding, consumeIndex, bindingIndex, service, producer, query } = execution;
    try {
      actions.signal.throwIfAborted();
      result.stage = "execution";
      const discovery = await actions.targets(consumer, binding);
      result.targets = discovery.targets;
      result.truncated = discovery.truncated;
      if (!result.targets.length) throw new Error("No runnable consumer Pod/Container");
      for (const [targetIndex, target] of result.targets.entries()) {
        actions.signal.throwIfAborted();
        result.stage = "execution";
        let send: SendHttp;
        try { send = await actions.sender(target); }
        catch (error) {
          result.error = [result.error, `${target.pod}/${target.container}: ${caseError(error)}`].filter(Boolean).join("\n");
          actions.checkpoint(result);
          continue;
        }
        result.stage = "provider";
        // Resolve fresh URLs after Pod readiness, once per target; signed links must not age in a queue.
        let provided: CaseProduceResult;
        try {
          provided = await actions.produce(service, producer, query);
          validateCaseProduceResult(provided, query.maxCases);
        } catch (error) {
          result.status = "failed";
          result.error = [result.error, `${target.pod}/${target.container} provider: ${caseError(error)}`].filter(Boolean).join("\n");
          actions.checkpoint(result);
          continue;
        }
        if (provided.reason && provided.cases.length) result.error = [result.error, `${target.pod}/${target.container}: ${caseError(provided.reason)}`].filter(Boolean).join("\n");
        if (provided.truncated) result.truncated = [result.truncated, provided.truncated.reason].filter(Boolean).join("; ");
        if (!provided.cases.length) {
          result.status = "empty";
          result.error = [result.error, `${target.pod}/${target.container}: ${caseError(provided.reason)}`].filter(Boolean).join("\n");
          continue;
        }
        result.stage = "request";
        for (const [caseIndex, item] of provided.cases.entries()) {
          actions.signal.throwIfAborted();
          if (!["GET", "HEAD"].includes(item.case.input.method)) {
            result.stage = "approval";
            const decision = await actions.approve(target, item);
            if (!decision.approved) {
              result.status = "cancelled";
              result.error = [result.error, `${target.pod}/${target.container} ${item.case.id}: ${approvalDeniedReason(decision.source)}`].filter(Boolean).join("\n");
              actions.checkpoint(result);
              continue;
            }
          }
          result.stage = "request";
          result.attempts.push(...await checkHttpCase({ item, target, send, signal: actions.signal,
            directory: actions.directory, prefix: `cases/${encodeURIComponent(consumer.name)}/${consumeIndex}/${bindingIndex}/${targetIndex}/${caseIndex}` }));
          actions.checkpoint(result);
        }
      }
      if (result.attempts.length && result.status !== "cancelled") result.status = result.error || result.truncated || result.attempts.some(attempt => attempt.status === "failed") ? "failed" : "passed";
    } catch (error) {
      result.error = [result.error, caseError(error)].filter(Boolean).join("\n");
      result.status = actions.signal.aborted ? "cancelled" : result.stage === "request" || result.stage === "provider" ? "failed" : "unavailable";
    } finally {
      if (actions.signal.aborted) result.status = "cancelled";
      result.finishedAt = new Date().toISOString();
      actions.checkpoint(result);
    }
    if (actions.signal.aborted) break;
  }
  return results;
}
