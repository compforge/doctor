import { mysqlDataSource, type ServiceDatabaseDataSource } from "@compforge/doctor-plugin";

/** The example Plugin owns its profile configuration schema; Core receives an initialized client. */
export const workerDatabase: ServiceDatabaseDataSource = {
  id: "primary-database", kind: "db", backend: "mysql",
  source: mysqlDataSource("example-worker-database", async context => {
    const config = context.config.database;
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Plugin config.database is required");
    const values = config as Record<string, unknown>;
    const required = (key: string) => {
      const value = values[key];
      if (typeof value !== "string" || !value.trim()) throw new Error(`Plugin config.database.${key} is required`);
      return value;
    };
    const port = values.port ?? 3306;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Plugin config.database.port must be an integer in 1..65535");
    }
    return { host: required("host"), port, database: required("database"), user: required("user"), password: required("password") };
  }),
};
