import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadCaseSet } from "@compforge/spec-case/model";
import { type CaseCatalog } from "@compforge/doctor-plugin";

/** Resolve and parse local CaseSets only when the offline catalog is read. */
export function localCaseCatalog(file?: string, cwd = process.cwd()): CaseCatalog & { readonly file?: string } {
  const path = file ? resolve(cwd, file) : ["doctor-cases.yaml", "doctor-cases.yml"]
    .map((name) => resolve(cwd, name)).find(existsSync);
  return {
    id: "core.local-file", file: path,
    load: () => {
      if (!path) return [];
      if (!existsSync(path)) throw new Error(`Case file not found: ${path}`);
      const caseSet = loadCaseSet(path);
      return [caseSet];
    },
  };
}
