import type {
  PluginContext,
  PluginDefinition,
  ServiceDataResult,
} from "@compforge/doctor-plugin";
import type { Executor } from "../../infra/k8s/executor";
import { resolveDataConfig, resolveDataServiceSelection } from "./config";
import { prepareDataAccess } from "./preparation";

export interface ResolveDataIdentifierOptions {
  inputId: string;
  identifier: string;
  namespace: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
}

export interface ResolvedDataIdentifier {
  inputId: string;
  identifier: string;
  value: string;
  service: string;
  resolvedAs: string;
}

/** 复用 data expansion 契约，把业务 ID 解析为 Plugin 声明的规范 ID。 */
export async function resolveDataIdentifier(
  opts: ResolveDataIdentifierOptions,
  plugin: PluginDefinition,
  executor: Executor,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<ResolvedDataIdentifier | undefined> {
  const expanders = plugin.services.servicesWith("data")
    .filter((service) => service.capabilities.data.expands?.length);
  if (!expanders.length) throw new Error("当前 Plugin 未声明业务 ID expansion capability");

  const config = resolveDataConfig({
    ids: [opts.inputId],
    namespace: opts.namespace,
    kubeconfig: opts.kubeconfig,
    context: opts.context,
    profile: opts.profile,
    config: opts.config,
    services: expanders.map((service) => service.name).join(","),
  }, plugin.services);
  const selections = await resolveDataServiceSelection({
    config,
    catalog: plugin.services,
    executor,
  });
  if (!selections) return undefined;

  const access = await prepareDataAccess(
    executor,
    config,
    selections,
    undefined,
    plugin.services,
    injectedContexts,
  );
  const ids = new Set([opts.inputId]);
  const results = new Map<string, readonly ServiceDataResult[]>();
  const failures: string[] = [];

  try {
    for (const selection of selections) {
      const declared = plugin.services.findWith(selection.service, "data")!;
      const confirmed = access.confirmed.find((item) => item.service === selection.service);
      if (!confirmed) {
        failures.push(`${selection.service}: 数据访问不可用`);
        continue;
      }
      if (confirmed.targetFact.status !== "collected") {
        failures.push(`${selection.service}: ${confirmed.targetFact.reason}`);
        continue;
      }
      if (!confirmed.context) {
        failures.push(`${selection.service}: Plugin context 不可用`);
        continue;
      }

      // 与 doctor data 一致：当前 expander 消费此前发现的 ID，不对自己新增的 ID 循环查询。
      const inputIds = [...ids];
      const serviceResults: ServiceDataResult[] = [];
      for (const inputId of inputIds) {
        try {
          const result = await declared.capabilities.data.inspect(confirmed.context, {
            inputId,
            results,
          });
          serviceResults.push(result);
          const summary = declared.capabilities.data.summarize(result);
          for (const value of Object.values(summary.identifiers)) {
            if (value?.trim()) ids.add(value.trim());
          }
          const value = summary.identifiers[opts.identifier]?.trim();
          if (value) {
            return {
              inputId: opts.inputId,
              identifier: opts.identifier,
              value,
              service: selection.service,
              resolvedAs: summary.resolvedAs,
            };
          }
        } catch (error) {
          failures.push(
            `${selection.service}/${inputId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      results.set(selection.service, serviceResults);
    }
  } finally {
    await access.close();
  }

  const suffix = failures.length ? `：${failures.join("；")}` : "";
  throw new Error(`无法从 biz-id '${opts.inputId}' 解析出 ${opts.identifier}${suffix}`);
}
