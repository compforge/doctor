import { validateHttpCase, type HttpCase } from "@compforge/spec-case/http";
import { validateExtension, type Extension, type ExtensionRegistration } from "./index";
import { validateExtensionNamespace } from "./registry";

export const CASE_PRODUCE_KIND = "case.produce";
export const CASE_CONSUME_KIND = "case.consume";

/** A consumer-owned relationship. Workload names refer to this Service's declarations. */
export interface CaseBinding {
  readonly id: string;
  readonly workload: string;
  readonly producer: { readonly namespace: string; readonly extension: string };
}

export interface CaseProduceQuery {
  readonly tenantId?: string;
  /** Bound preparation at its data source; temporary URLs belong only to this invocation. */
  readonly maxCases: number;
}

export interface CaseProduceResult {
  readonly cases: readonly {
    readonly case: HttpCase;
    /** Ordered diagnostic routes: try the configured URL first, then alternatives on failure. */
    readonly targets: readonly {
      readonly id: string;
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      /** Resolved request body (identities, fresh session IDs); never part of Case identity or reports. */
      readonly body?: string;
    }[];
  }[];
  /** Required for an empty list; with Cases, explains a partial preparation failure. Neither means full success. */
  readonly reason?: string;
  readonly truncated?: { readonly reason: string };
}

export interface CaseProduceExtension extends Extension<CaseProduceQuery, CaseProduceResult> {
  readonly kind: typeof CASE_PRODUCE_KIND;
}

export interface CaseConsumeQuery { readonly tenantId?: string }
export interface CaseConsumeResult { readonly bindings: readonly CaseBinding[] }

/** @spec Both kinds return data through the normal Extension envelope; Health owns execution. */
export interface CaseConsumeExtension extends Extension<CaseConsumeQuery, CaseConsumeResult> {
  readonly kind: typeof CASE_CONSUME_KIND;
}

export function requireCaseConsumeExtension(extension: ExtensionRegistration): CaseConsumeExtension {
  validateExtension(extension);
  if (extension.kind !== CASE_CONSUME_KIND) throw new Error(`Unsupported Case consumer kind: ${extension.kind}`);
  return extension as CaseConsumeExtension;
}

export function validateCaseConsumeResult(value: CaseConsumeResult): void {
  if (!value || typeof value !== "object") throw new Error("Case consumer must return bindings");
  validateCaseBindings(value.bindings);
}

function name(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`);
}

export function validateCaseBindings(bindings: readonly CaseBinding[]): void {
  if (!Array.isArray(bindings)) throw new Error("Case bindings must be an array");
  const ids = new Set<string>();
  for (const binding of bindings) {
    name(binding.id, "Case binding id");
    name(binding.workload, "Case binding workload");
    if (ids.has(binding.id)) throw new Error(`Duplicate Case binding: ${binding.id}`);
    ids.add(binding.id);
    validateExtensionNamespace(binding.producer?.namespace);
    name(binding.producer?.extension, "Case provider extension");
  }
}

export function requireCaseProduceExtension(extension: ExtensionRegistration): CaseProduceExtension {
  validateExtension(extension);
  if (extension.kind !== CASE_PRODUCE_KIND) throw new Error(`Unsupported Case provider kind: ${extension.kind}`);
  return extension as CaseProduceExtension;
}

/** Dynamic plugin output is validated before requests enter the consumer's execution channel. */
export function validateCaseProduceResult(value: CaseProduceResult, maxCases: number): void {
  if (!value || !Array.isArray(value.cases) || value.cases.length > maxCases) throw new Error(`Case producer must return at most ${maxCases} Cases`);
  if (!value.cases.length) name(value.reason, "Empty Case list reason");
  if (value.truncated) name(value.truncated.reason, "Case truncation reason");
  const ids = new Set<string>();
  for (const item of value.cases) {
    validateHttpCase(item.case);
    if (ids.has(item.case.id)) throw new Error(`Duplicate Case: ${item.case.id}`);
    ids.add(item.case.id);
    // Non-read HTTP methods are gated by Health before any request, and never replayed via alternates.
    const readOnly = ["GET", "HEAD"].includes(item.case.input.method);
    if (readOnly && item.case.input.body !== undefined) throw new Error("GET/HEAD Cases cannot have a body");
    caseSseExpectation(item.case);
    if (!item.case.judge?.e2e?.http) throw new Error("Health HTTP Case requires judge.e2e.http criteria");
    if (!Array.isArray(item.targets) || !item.targets.length || item.targets.length > 5) throw new Error("Case must provide one to five HTTP targets");
    if (!readOnly && item.targets.length !== 1) throw new Error("Non-read HTTP Cases require exactly one target; automatic replay is unsafe");
    const targets = new Set<string>();
    for (const target of item.targets) {
      if (target.body !== undefined && (typeof target.body !== "string" || readOnly)) throw new Error("Only non-read HTTP Cases can provide a runtime string body");
      name(target.id, "Case target id");
      if (targets.has(target.id)) throw new Error("Duplicate Case target");
      targets.add(target.id);
      name(target.url, "Case target URL");
      const url = new URL(target.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Case target must be a credential-free HTTP(S) URL");
      if (target.headers !== undefined && (!target.headers || typeof target.headers !== "object" || Array.isArray(target.headers))) throw new Error("Invalid Case target headers");
      for (const [key, header] of Object.entries(target.headers ?? {})) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof header !== "string" || /[\r\n]/.test(header)) throw new Error("Invalid Case target header");
      }
    }
  }
}

/** Declarative SSE checks in canonical judge.e2e; event vocabulary belongs to the producer. */
export interface CaseSseExpectation {
  readonly eventField: string;
  readonly terminalEvent: string;
  readonly errorEvents: readonly string[];
  /** At least one of these response events must be present, in addition to the terminal event. */
  readonly requiredEvents: readonly string[];
}

export function caseSseExpectation(value: HttpCase): CaseSseExpectation | undefined {
  const raw = value.judge?.e2e?.sse;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Case SSE expectation");
  const sse = raw as Record<string, unknown>;
  if (Object.keys(sse).some(key => !["eventField", "terminalEvent", "errorEvents", "requiredEvents"].includes(key))) throw new Error("Unknown Case SSE expectation field");
  name(sse.eventField, "SSE eventField");
  name(sse.terminalEvent, "SSE terminalEvent");
  for (const key of ["errorEvents", "requiredEvents"]) {
    if (!Array.isArray(sse[key]) || !sse[key].length) throw new Error(`SSE ${key} must be a nonempty list`);
    for (const event of sse[key]) name(event, `SSE ${key} event`);
  }
  if (value.judge?.e2e?.http?.contentType !== "text/event-stream") throw new Error("SSE Case must expect text/event-stream");
  return sse as unknown as CaseSseExpectation;
}
