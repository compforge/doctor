import type { TenantFacet } from "../facet";
import { CONFIGURATION_TENANT_FACET } from "./configuration";
import { INTENTION_TENANT_FACET } from "./intention";
import { MODEL_TENANT_FACET } from "./model";

export const TENANT_FACETS: readonly TenantFacet[] = [
  MODEL_TENANT_FACET,
  INTENTION_TENANT_FACET,
  CONFIGURATION_TENANT_FACET,
];

export * from "./configuration";
export * from "./intention";
export * from "./model";
