import type { ServiceCaseIdentityRequirement, ServiceRequestIdentity } from "../service";
import { validateHttpCase, type HttpCase } from "@compforge/spec-case/http";
import { validateExtension, type Extension, type ExtensionRegistration } from "./index";

export const CASE_PRODUCE_KIND = "case.produce";

export interface CaseProduceQuery {
  readonly tenantId?: string;
  /** Prepared probe identity; independent of the command's statistics scope. */
  readonly requestIdentity?: ServiceRequestIdentity;
  /** Prepared tenant for tenant-only probes; does not narrow the Health statistics query. */
  readonly requestTenantId?: string;
  /** Bound preparation at its data source; temporary URLs belong only to this invocation. */
  readonly maxCases: number;
}

/** A tenant-only dependency must not force the user to select an unrelated real user. */
export interface CaseTenantRequirement {
  configured(config: Readonly<Record<string, unknown>>): string | undefined;
}

export interface CaseProduceResult {
  readonly cases: readonly {
    readonly case: HttpCase;
    /** Runtime business object; never changes the canonical stimulus identity. */
    readonly subject?: { readonly id: string; readonly label?: string };
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
  readonly requestIdentity?: ServiceCaseIdentityRequirement;
  readonly requestTenant?: CaseTenantRequirement;
  readonly kind: typeof CASE_PRODUCE_KIND;
}

function name(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`);
}

export function requireCaseProduceExtension(extension: ExtensionRegistration): CaseProduceExtension {
  validateExtension(extension);
  if (extension.kind !== CASE_PRODUCE_KIND) throw new Error(`Unsupported Case provider kind: ${extension.kind}`);
  const declared = extension as CaseProduceExtension;
  if (declared.requestIdentity !== undefined && (!declared.requestIdentity || typeof declared.requestIdentity.configured !== "function")) {
    throw new Error(`${extension.id}: invalid Case requestIdentity`);
  }
  if (declared.requestTenant !== undefined) {
    if (!declared.requestTenant || typeof declared.requestTenant.configured !== "function") throw new Error(`${extension.id}: invalid Case requestTenant`);
    if (declared.requestIdentity) throw new Error(`${extension.id}: declare either requestTenant or requestIdentity`);
  }
  return declared;
}

/** Dynamic plugin output is validated before requests enter the consumer's execution channel. */
export function validateCaseProduceResult(value: CaseProduceResult, maxCases: number): void {
  if (!value || !Array.isArray(value.cases) || value.cases.length > maxCases) throw new Error(`Case producer must return at most ${maxCases} Cases`);
  if (!value.cases.length) name(value.reason, "Empty Case list reason");
  if (value.truncated) name(value.truncated.reason, "Case truncation reason");
  const ids = new Set<string>();
  for (const item of value.cases) {
    validateHttpCase(item.case);
    if (item.subject) {
      name(item.subject.id, "Case subject id");
      if (item.subject.label !== undefined) name(item.subject.label, "Case subject label");
    }
    const identity = JSON.stringify([item.case.id, item.subject?.id]);
    if (ids.has(identity)) throw new Error(`Duplicate Case: ${item.case.id}`);
    ids.add(identity);
    // Non-read HTTP methods are gated by Health before any request, and never replayed via alternates.
    const readOnly = ["GET", "HEAD"].includes(item.case.input.method);
    if (readOnly && item.case.input.body !== undefined) throw new Error("GET/HEAD Cases cannot have a body");
    caseSseExpectation(item.case);
    caseModelExpectation(item.case);
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

export type CaseModelType = "llm" | "embedding" | "rerank";

/** Protocol validation, not a quality judgment of the generated answer. */
export function caseModelExpectation(value: HttpCase): CaseModelType | undefined {
  const raw = value.judge?.e2e?.model;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).some(key => key !== "type")
    || !["llm", "embedding", "rerank"].includes((raw as { type: string }).type)) {
    throw new Error("Invalid Case model expectation");
  }
  if (value.judge?.e2e?.http?.contentType !== "application/json") throw new Error("Model Case must expect application/json");
  return (raw as { type: CaseModelType }).type;
}
