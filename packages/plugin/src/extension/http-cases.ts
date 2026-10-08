import { validateExtension, type Extension, type ExtensionRegistration } from "./index";
import { validateExtensionNamespace } from "./registry";

export const CASE_HTTP_PROVIDE_KIND = "case.http.provide";

/** A consumer-owned relationship. Workload names refer to this Service's declarations. */
export interface CaseBinding {
  readonly id: string;
  readonly workload: string;
  readonly provider: { readonly namespace: string; readonly extension: string };
}

export interface HttpCaseQuery {
  readonly tenantId?: string;
  /** Bound preparation at its data source; temporary URLs belong only to this invocation. */
  readonly maxCases: number;
}

/** Read-only HTTP checks run by Core from the consumer's declared Workload. */
export interface ProvidedHttpCase {
  readonly id: string;
  readonly description: string;
  readonly request: {
    readonly url: string;
    readonly method?: "GET" | "HEAD";
    readonly headers?: Readonly<Record<string, string>>;
  };
  readonly expect: { readonly status: readonly number[]; readonly contentType?: string };
  /** Alternate URLs are diagnostic attempts, never a mutation of the consumer's configuration. */
  readonly alternatives?: readonly { readonly id: string; readonly url: string }[];
}

export interface HttpCasesResult {
  readonly cases: readonly ProvidedHttpCase[];
  /** Required for an empty list; unavailable samples are not a successful network check. */
  readonly reason?: string;
  readonly truncated?: { readonly reason: string };
}

export interface HttpCaseProviderExtension extends Extension<HttpCaseQuery, HttpCasesResult> {
  readonly kind: typeof CASE_HTTP_PROVIDE_KIND;
}

function name(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`);
}

export function validateCaseBindings(bindings: readonly CaseBinding[]): void {
  if (!Array.isArray(bindings)) throw new Error("Service.caseBindings must be an array");
  const ids = new Set<string>();
  for (const binding of bindings) {
    name(binding.id, "Case binding id");
    name(binding.workload, "Case binding workload");
    if (ids.has(binding.id)) throw new Error(`Duplicate Case binding: ${binding.id}`);
    ids.add(binding.id);
    validateExtensionNamespace(binding.provider?.namespace);
    name(binding.provider?.extension, "Case provider extension");
  }
}

export function requireHttpCaseProviderExtension(extension: ExtensionRegistration): HttpCaseProviderExtension {
  validateExtension(extension);
  if (extension.kind !== CASE_HTTP_PROVIDE_KIND) throw new Error(`Unsupported Case provider kind: ${extension.kind}`);
  return extension as HttpCaseProviderExtension;
}

function httpUrl(value: string): void {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Case URL must be credential-free HTTP(S)");
}

/** Dynamic ESM output crosses a runtime boundary; invalid requests must never reach Pod exec. */
export function validateHttpCasesResult(value: HttpCasesResult, maxCases: number): void {
  if (!value || !Array.isArray(value.cases) || value.cases.length > maxCases) throw new Error(`Case provider must return at most ${maxCases} Cases`);
  if (!value.cases.length) name(value.reason, "Empty Case list reason");
  if (value.truncated) name(value.truncated.reason, "Case truncation reason");
  const ids = new Set<string>();
  for (const item of value.cases) {
    name(item.id, "Case id");
    name(item.description, "Case description");
    if (ids.has(item.id)) throw new Error(`Duplicate Case: ${item.id}`);
    ids.add(item.id);
    httpUrl(item.request.url);
    if (item.request.method !== undefined && !["GET", "HEAD"].includes(item.request.method)) throw new Error("Overview HTTP Cases only allow GET/HEAD");
    if (!Array.isArray(item.expect?.status) || !item.expect.status.length
      || item.expect.status.some((status: number) => !Number.isInteger(status) || status < 100 || status > 599)) throw new Error("Invalid Case expected status");
    if (item.expect.contentType !== undefined) name(item.expect.contentType, "Case expected content type");
    for (const [key, header] of Object.entries(item.request.headers ?? {})) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof header !== "string" || /[\r\n]/.test(header)) throw new Error("Invalid Case HTTP header");
    }
    const alternatives = new Set(["primary"]);
    if (item.alternatives && (!Array.isArray(item.alternatives) || item.alternatives.length > 4)) throw new Error("At most four Case alternatives are allowed");
    for (const alternate of item.alternatives ?? []) {
      name(alternate.id, "Case alternative id");
      if (alternatives.has(alternate.id)) throw new Error("Duplicate Case alternative");
      alternatives.add(alternate.id);
      httpUrl(alternate.url);
    }
  }
}
