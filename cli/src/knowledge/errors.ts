import {
  ERROR_CATALOG_KIND, loadErrorCatalog, requireErrorCatalogExtension,
  type ErrorCatalog, type ErrorDefinition, type PluginDefinition,
} from "@compforge/doctor-plugin";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";

export interface KnowledgeErrorCatalog {
  namespace: string;
  extensionId: string;
  source: ErrorCatalog["source"];
  total: number;
  errors: readonly ErrorDefinition[];
}

export interface KnowledgeErrors {
  query?: string;
  namespace?: string;
  catalogs: KnowledgeErrorCatalog[];
}

/** Query only selected offline catalogs; preserve every matching definition and its provenance. */
export function queryErrorCatalogs(plugin: PluginDefinition | undefined,
  options: { query?: string; namespace?: string } = {}): KnowledgeErrors {
  const query = options.query?.trim();
  if (query === "") throw new Error("Error query must not be empty");
  const providers = createDoctorExtensionRegistry(plugin).extensions(ERROR_CATALOG_KIND, options.namespace);
  return {
    ...(query === undefined ? {} : { query }),
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    catalogs: providers.map(({ namespace, extension }) => {
      const catalog = loadErrorCatalog(requireErrorCatalogExtension(extension));
      const errors = query === undefined ? catalog.errors : catalog.errors.filter(error => error.code === query
        || [error.name, ...(error.aliases ?? [])].some(name => name.toLowerCase().includes(query.toLowerCase())));
      return { namespace, extensionId: extension.id, source: catalog.source, total: catalog.errors.length, errors };
    }),
  };
}

export function formatErrorCatalogs(result: KnowledgeErrors): string {
  if (!result.catalogs.length) return `No error catalogs declared${result.namespace ? ` in namespace '${result.namespace}'` : ""}.\n`;
  const lines: string[] = [];
  for (const catalog of result.catalogs) {
    lines.push(`${catalog.namespace} · ${catalog.extensionId} · ${catalog.source.name}@${catalog.source.version}`);
    if (catalog.source.reference) lines.push(`  Source: ${catalog.source.reference}`);
    lines.push(`  ${catalog.errors.length}/${catalog.total} definitions`);
    for (const error of catalog.errors) {
      lines.push(`  ${error.code} · ${error.name}`, `    ${error.description}`);
      if (error.aliases?.length) lines.push(`    Aliases: ${error.aliases.join(", ")}`);
      if (error.exception) lines.push(`    Exception: ${error.exception}`);
      if (error.defaultMessage) lines.push(`    Default message: ${error.defaultMessage}`);
      if (error.defaultHttpStatus !== undefined) lines.push(`    Default HTTP status: ${error.defaultHttpStatus}`);
      if (error.defaultDisposition) lines.push(`    Default disposition: ${error.defaultDisposition}`);
      for (const reference of error.references ?? []) lines.push(`    Reference: ${reference}`);
    }
  }
  if (result.query && !result.catalogs.some(catalog => catalog.errors.length)) {
    lines.push(`No error definition matches '${result.query}' in the selected catalogs.`);
  }
  return `${lines.join("\n")}\n`;
}
