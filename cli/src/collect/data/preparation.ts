import type {
  PluginContext,
  ServiceCatalog,
} from "@compforge/doctor-plugin";
import type { Executor } from "../../infra/k8s/executor";
import { createPluginContext } from "../../plugin/context";
import type { EvidenceBundle } from "../evidence";
import type {
  DataConfig,
  DataServiceSelection,
  DataTargetFact,
  SupportedDataService,
} from "./model";

export function isSupportedDataService(
  service: string,
  catalog: ServiceCatalog,
): service is SupportedDataService {
  return catalog.findWith(service, "data") !== undefined;
}

export interface ConfirmedDataServiceTarget {
  service: string;
  pod?: string;
  context?: PluginContext;
  targetFact:
    | ({ status: "collected" } & DataTargetFact)
    | { status: "unavailable" | "failed"; reason: string };
}

export interface DataAccessPreparation {
  confirmed: readonly ConfirmedDataServiceTarget[];
  close(): Promise<void>;
}

function failureReason(stderr: string, exitCode: number | null): string {
  return stderr.trim().split("\n")[0] || `exit=${exitCode}`;
}

function parseEnvironment(raw: string): Record<string, string> {
  return Object.fromEntries(raw.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
}

/** Doctor 只确认 Service 位置并注入上下文；数据源协议和访问实现由 Plugin 持有。 */
export async function prepareDataAccess(
  executor: Executor,
  config: DataConfig,
  selections: readonly DataServiceSelection[],
  bundle: EvidenceBundle | undefined,
  catalog: ServiceCatalog,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<DataAccessPreparation> {
  const confirmed: ConfirmedDataServiceTarget[] = [];
  const managedContexts: Array<ReturnType<typeof createPluginContext>> = [];

  for (const selection of selections) {
    const declared = catalog.findWith(selection.service, "data");
    if (!declared) {
      confirmed.push({
        ...selection,
        targetFact: {
          status: "unavailable",
          reason: `Doctor 未注册 Service '${selection.service}' 的数据贡献能力`,
        },
      });
      continue;
    }
    if (!selection.pod && !injectedContexts?.[selection.service]) {
      confirmed.push({
        ...selection,
        targetFact: { status: "unavailable", reason: `Service '${selection.service}' 没有 Running Pod` },
      });
      continue;
    }

    let context = injectedContexts?.[selection.service];
    let managed: ReturnType<typeof createPluginContext> | undefined;
    if (!context) {
      const env = await executor.run(["exec", `pod/${selection.pod}`, "--", "env"], { timeoutMs: 20_000 });
      bundle?.addStep({
        id: `service-context-${selection.service}`,
        title: `${selection.service} 运行时环境`,
        risk: "observe",
        status: env.ok ? "ok" : "failed",
        reason: env.ok ? undefined : failureReason(env.stderr, env.exitCode),
        command: env.command,
        exitCode: env.exitCode,
        durationMs: env.durationMs,
        // Service 环境可能含凭据，只注入 Plugin，不写入 Evidence。
      });
      if (!env.ok) {
        confirmed.push({
          ...selection,
          targetFact: {
            status: "failed",
            reason: `读取 ${selection.service} 运行时环境失败：${failureReason(env.stderr, env.exitCode)}`,
          },
        });
        continue;
      }
      managed = createPluginContext(executor, config.kube, {
        profileName: config.profileName,
        databaseIdentity: config.fallbackIdentity,
        service: {
          name: selection.service,
          pod: selection.pod,
          environment: parseEnvironment(env.stdout),
        },
      });
      context = managed;
    }

    try {
      const target = await declared.capabilities.data.inspectTarget(context);
      if (managed) managedContexts.push(managed);
      confirmed.push({
        ...selection,
        context,
        targetFact: {
          status: "collected",
          service: selection.service,
          pod: selection.pod ?? context.service.pod ?? "—",
          ...target,
        },
      });
    } catch (error) {
      await Promise.allSettled(managed ? [managed.dispose()] : []);
      confirmed.push({
        ...selection,
        targetFact: {
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return {
    confirmed,
    close: async () => {
      const settled = await Promise.allSettled(managedContexts.map((context) => context.dispose()));
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}
