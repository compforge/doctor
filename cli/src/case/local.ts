import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadCaseSet } from "@compforge/spec-case/model";
import { CASE_CATALOG_KIND, type CaseCatalogExtension } from "@compforge/doctor-plugin";

/** Resolve and parse local CaseSets only when the catalog invokes this extension. */
export function localCaseCatalogExtension(file?: string, cwd = process.cwd()): CaseCatalogExtension & { readonly file?: string } {
  const path = file ? resolve(cwd, file) : ["doctor-cases.yaml", "doctor-cases.yml"]
    .map((name) => resolve(cwd, name)).find(existsSync);
  return {
    id: "core.local-file", kind: CASE_CATALOG_KIND, file: path,
    load: () => {
      if (!path) return [];
      if (!existsSync(path)) throw new Error(`Case file not found: ${path}`);
      const caseSet = loadCaseSet(path);
      for (const item of caseSet.cases) {
        if (!["http", "model", "perf", "both"].includes(item.facets?.command ?? "")) {
          throw new Error(`${path}: Case '${item.id}' 需要 facets.command: http、model、perf 或 both`);
        }
      }
      return [caseSet];
    },
  };
}
