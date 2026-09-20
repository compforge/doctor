import type { Extension, RegisteredExtension } from "./index";
import type { OverviewFacet, OverviewQuery, OverviewFacetResult, OverviewSampleQuery, OverviewSample } from "../overview";

export const OVERVIEW_SUMMARIZE_KIND = "overview.summarize";
export const OVERVIEW_SAMPLE_KIND = "overview.sample";

export interface OverviewSummarizeExtension extends Extension<OverviewQuery, readonly OverviewFacetResult[]> {
  readonly kind: typeof OVERVIEW_SUMMARIZE_KIND;
  readonly facets: readonly OverviewFacet[];
}

export interface OverviewSampleExtension extends Extension<OverviewSampleQuery, readonly OverviewSample[]> {
  readonly kind: typeof OVERVIEW_SAMPLE_KIND;
}

export function requireOverviewSummarizeExtension(extension: RegisteredExtension): OverviewSummarizeExtension {
  const value = extension as OverviewSummarizeExtension;
  if (value.kind !== OVERVIEW_SUMMARIZE_KIND || !Array.isArray(value.facets) || !value.facets.length) {
    throw new Error(`${extension.id}: overview.summarize requires facets`);
  }
  const seen = new Set<string>();
  for (const facet of value.facets) {
    if (!facet || [facet.id, facet.title, facet.description].some(item => typeof item !== "string" || !item.trim()) || seen.has(facet.id)) {
      throw new Error(`${extension.id}: invalid or duplicate overview facet`);
    }
    seen.add(facet.id);
  }
  return value;
}

export function requireOverviewSampleExtension(extension: RegisteredExtension): OverviewSampleExtension {
  if (extension.kind !== OVERVIEW_SAMPLE_KIND) throw new Error(`Expected ${OVERVIEW_SAMPLE_KIND}, got ${extension.kind}`);
  return extension as OverviewSampleExtension;
}
