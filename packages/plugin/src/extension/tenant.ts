import type { Extension, RegisteredExtension } from "./index";
import type { ServiceEndpoint, TenantSummary, UserDirectorySearch, UserDirectorySearchResult } from "../service";
import { requireExtensionEndpoint } from "./endpoint";

export const TENANT_LIST_KIND = "tenant.list";
export const TENANT_RESOLVE_KIND = "tenant.resolve";
export const USER_SEARCH_KIND = "user.search";

export interface TenantListExtension extends Extension<void, TenantSummary[]> {
  readonly kind: typeof TENANT_LIST_KIND;
  readonly endpoint: ServiceEndpoint;
}

export interface TenantResolveExtension extends Extension<{ name: string }, TenantSummary> {
  readonly kind: typeof TENANT_RESOLVE_KIND;
  readonly endpoint: ServiceEndpoint;
}

export interface UserSearchExtension extends Extension<UserDirectorySearch, UserDirectorySearchResult> {
  readonly kind: typeof USER_SEARCH_KIND;
  readonly endpoint: ServiceEndpoint;
}

export function requireTenantListExtension(extension: RegisteredExtension): TenantListExtension {
  if (extension.kind !== TENANT_LIST_KIND) throw new Error(`Expected ${TENANT_LIST_KIND}, got ${extension.kind}`);
  requireExtensionEndpoint(extension);
  return extension as TenantListExtension;
}

export function requireTenantResolveExtension(extension: RegisteredExtension): TenantResolveExtension {
  if (extension.kind !== TENANT_RESOLVE_KIND) throw new Error(`Expected ${TENANT_RESOLVE_KIND}, got ${extension.kind}`);
  requireExtensionEndpoint(extension);
  return extension as TenantResolveExtension;
}

export function requireUserSearchExtension(extension: RegisteredExtension): UserSearchExtension {
  if (extension.kind !== USER_SEARCH_KIND) throw new Error(`Expected ${USER_SEARCH_KIND}, got ${extension.kind}`);
  requireExtensionEndpoint(extension);
  return extension as UserSearchExtension;
}

function summary(value: unknown, kind: string): TenantSummary {
  if (!value || typeof value !== "object") throw new Error(`${kind} returned an invalid identity`);
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim() || typeof item.name !== "string" || typeof item.displayName !== "string") {
    throw new Error(`${kind} returned an invalid identity`);
  }
  return value as TenantSummary;
}

export function tenantListOutput(value: unknown): TenantSummary[] {
  if (!Array.isArray(value)) throw new Error("tenant.list must return an array");
  return value.map(item => summary(item, TENANT_LIST_KIND));
}

export function tenantResolveOutput(value: unknown): TenantSummary {
  return summary(value, TENANT_RESOLVE_KIND);
}

export function userSearchOutput(value: unknown): UserDirectorySearchResult {
  const item = value as UserDirectorySearchResult | undefined;
  if (!item || !Array.isArray(item.users) || !Number.isInteger(item.total) || item.total < 0 || item.total < item.users.length) {
    throw new Error("user.search returned an invalid page");
  }
  item.users.forEach(user => summary(user, USER_SEARCH_KIND));
  return item;
}
