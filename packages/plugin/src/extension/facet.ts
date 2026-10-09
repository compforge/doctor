import { validateExtension, type Extension, type ExtensionRegistration } from "./index";
import type { FacetDefinition, FacetSummaryQuery, FacetSummary, FacetSampleQuery, FacetSample } from "../facet";

export const FACET_SUMMARIZE_KIND = "facet.summarize";
export const FACET_SAMPLE_KIND = "facet.sample";

export interface FacetSummarizeExtension extends Extension<FacetSummaryQuery, readonly FacetSummary[]> {
  readonly kind: typeof FACET_SUMMARIZE_KIND;
  readonly facets: readonly FacetDefinition[];
}

export interface FacetSampleExtension extends Extension<FacetSampleQuery, readonly FacetSample[]> {
  readonly kind: typeof FACET_SAMPLE_KIND;
}

export function requireFacetSummarizeExtension(extension: ExtensionRegistration): FacetSummarizeExtension {
  validateExtension(extension);
  const value = extension as FacetSummarizeExtension;
  if (value.kind !== FACET_SUMMARIZE_KIND || !Array.isArray(value.facets) || !value.facets.length) {
    throw new Error(`${extension.id}: facet.summarize requires facets`);
  }
  const seen = new Set<string>();
  for (const facet of value.facets) {
    if (!facet || [facet.id, facet.title, facet.description].some(item => typeof item !== "string" || !item.trim()) || seen.has(facet.id)) {
      throw new Error(`${extension.id}: invalid or duplicate facet`);
    }
    seen.add(facet.id);
  }
  return value;
}

export function requireFacetSampleExtension(extension: ExtensionRegistration): FacetSampleExtension {
  validateExtension(extension);
  if (extension.kind !== FACET_SAMPLE_KIND) throw new Error(`Expected ${FACET_SAMPLE_KIND}, got ${extension.kind}`);
  return extension as FacetSampleExtension;
}

