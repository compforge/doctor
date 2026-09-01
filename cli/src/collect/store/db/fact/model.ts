import type { Fact } from "../../../protocol";

export interface DbConfigurationFact {
  backend: string;
  endpoint: string;
  database: string;
  username: string;
  credentials: "configured";
  source: string;
}

export interface DbAccessFact {
  backend: "mysql";
  channel: "service-port-forward";
}

export interface DbInspectionFacts {
  configuration: Fact<DbConfigurationFact, "store.db.configuration">;
  access: Fact<DbAccessFact, "store.db.access">;
}
