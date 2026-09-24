import type { CaseCatalogExtension } from "@compforge/doctor-plugin";
import { CASE_CATALOG_KIND } from "@compforge/doctor-plugin";

export const httpCaseCatalogExtension: CaseCatalogExtension = {
  id: "core.http", kind: CASE_CATALOG_KIND,
  load: () => [{
    caseset: "doctor_http", schema_version: 1,
    facets: { command: { values: ["http"] } },
    cases: [{ id: "http_get_root", desc: "GET / 连通性", input: { method: "GET", path: "/", expect: { status: 200 } }, facets: { command: "http" } }],
  }],
};
