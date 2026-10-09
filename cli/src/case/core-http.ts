import type { CaseCatalog } from "@compforge/doctor-plugin";

export const httpCaseCatalog: CaseCatalog = {
  id: "core.http",
  load: () => [{
    caseset: "doctor_http", schema_version: 1,
    facets: { command: { values: ["http"] } },
    cases: [{ id: "http_get_root", desc: "GET / 连通性", input: { method: "GET", path: "/", expect: { status: 200 } }, facets: { command: "http" } }],
  }],
};
