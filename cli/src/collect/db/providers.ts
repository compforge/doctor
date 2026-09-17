import { serviceDataSources, servicesWithDataSource } from "@compforge/doctor-plugin";
import { clientKey } from "@compforge/harness-common";
import { CommandInputError, type CommandContext } from "../../command";
import { chooseParameter, ParameterCancelled } from "../../terminal/parameters";
import { borrowDatabase, resolveDatabaseConfig, resolveDatabaseTarget } from "../../datasource/database";
import { databaseFailure, type DbProvider } from "./discovery";
import type { DbRequest } from "./input";

export interface ProviderResolution {
  service: string;
  providers: DbProvider[];
  failures: { id: string; description?: string; reason: string }[];
}

export async function resolveDbProviders(context: CommandContext, request: DbRequest): Promise<ProviderResolution> {
  const services = servicesWithDataSource(context.plugin.services, "db").map(service => service.name);
  const requested = request.input.service ?? await chooseParameter("--service", services, request.interactive);
  const service = context.plugin.services.find(requested)?.name ?? requested;
  if (!services.includes(service)) throw new CommandInputError(`Service '${service}' 未声明 DB capability`);
  const providers: DbProvider[] = [];
  const failures: ProviderResolution["failures"] = [];
  const identities = new Map<string, DbProvider>();
  for (const capability of serviceDataSources(context.plugin.services, service, "db")) {
    if (capability.kind !== "db") continue;
    context.signal.throwIfAborted();
    const declaration = { id: capability.id, description: capability.description };
    try {
      const resolved = await resolveDatabaseConfig(context, {
        ...request.input, ...context.options.environment, profile: context.profile.name,
      }, service, capability, request.interactive);
      const database = await resolveDatabaseTarget(resolved.config, resolved.executor, context);
      if (!database.target) { failures.push({ ...declaration, reason: database.reason ?? "未解析到数据库目标" }); continue; }
      const target = database.target;
      if (!target.host || !target.user || !target.database || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || typeof target.password !== "string") {
        throw new CommandInputError("Service 返回了无效的数据库目标");
      }
      // Multiple declarations of the same account/instance are one SQL routing target.
      const identity = clientKey("db-routing", {
        host: target.host, port: target.port, user: target.user, password: target.password,
        source: capability.source?.clientKey, access: capability.access, kube: resolved.config.collect.kubernetes,
      });
      const existing = identities.get(identity);
      if (existing) { existing.dataSources.push(declaration); continue; }
      const client = await borrowDatabase(context, resolved.config, resolved.executor, target);
      const provider: DbProvider = {
        dataSources: [declaration],
        id: capability.id, target, source: database.source,
        query: (sql, values, limits, selectedDatabase) => client.database.queryReadonly(
          { ...target, database: selectedDatabase ?? target.database }, sql, values, limits,
        ),
      };
      identities.set(identity, provider);
      providers.push(provider);
    } catch (error) {
      if (error instanceof ParameterCancelled || context.signal.aborted) throw error;
      failures.push({ ...declaration, reason: error instanceof CommandInputError ? error.message : databaseFailure(error) });
    }
  }
  return { service, providers, failures };
}
