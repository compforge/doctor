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
    }[];
  }[];
  /** Required for an empty list; unavailable samples are not a successful network check. */
  readonly reason?: string;
  readonly truncated?: { readonly reason: string };
}

export interface CaseProduceExtension extends Extension<CaseProduceQuery, CaseProduceResult> {
  readonly kind: typeof CASE_PRODUCE_KIND;
}

export interface CaseConsumeQuery { readonly tenantId?: string }
export interface CaseConsumeResult { readonly bindings: readonly CaseBinding[] }

/** @spec Both kinds return data through the normal Extension envelope; Overview owns execution. */
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
    // Overview is a read-only diagnostic consumer of the shared HTTP profile.
    if (!["GET", "HEAD"].includes(item.case.input.method) || item.case.input.body !== undefined) throw new Error("Overview HTTP Cases only allow body-free GET/HEAD");
    if (!item.case.judge?.e2e?.http) throw new Error("Overview HTTP Case requires judge.e2e.http criteria");
    if (!Array.isArray(item.targets) || !item.targets.length || item.targets.length > 5) throw new Error("Case must provide one to five HTTP targets");
    const targets = new Set<string>();
    for (const target of item.targets) {
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
