import { caseProducer } from "@compforge/doctor-plugin";
import { CommandInputError, CommandStatus, defineCommand, type CommandInput } from "../command";
import { commandOptions } from "../command/options";
import { createKubernetesExecutor, resolveKubernetesCommandConfig } from "../command/kubernetes-target";
import { caseOperationInvoker } from "../health/case-runtime";
import { openPluginContext } from "../plugin/context";
import { discoverTenantDirectory } from "../plugin/tenant-directory";
import { writeOutput } from "../terminal/output";
import { useLogger } from "../terminal/log";
import { doctorCaseCatalog } from "./catalog";
import { resolveCaseProducerIdentity, resolveCaseProducerTenant } from "./prepare-identity";
import { listDoctorCases, formatCaseList, type CaseListOptions, type CaseListActions } from "./list";

export type CaseListInput = CommandInput & CaseListOptions & {
  caseFile?: string; tenantId?: string; userId?: string; send?: boolean;
};
export const caseListCommand = defineCommand<CaseListInput, void>({
  name: "doctor case list",
  validate: input => {
    if (input.send) throw new CommandInputError("--list 与 --send 不能同时使用");
  },
  prepare: async (context, input) => {
    if (!["json", "summary"].includes(context.options.format ?? "summary")) throw new CommandInputError("case --list 仅支持 -f json/summary");
    if (context.options.output !== undefined) throw new CommandInputError("case --list 输出到终端，请用 shell 重定向保存");
    await context.resolvePlugin();
    return input;
  },
  run: async (context, input) => {
    const plugin = await context.resolvePlugin();
    const catalog = doctorCaseCatalog(plugin, input.caseFile, undefined, input.services?.length === 1 ? input.services[0] : undefined);
    let prepared: Promise<Omit<CaseListActions, "signal">> | undefined;
    const access = () => prepared ??= (async () => {
      await context.ensureEnvironment({ kubernetes: true });
      const kube = await resolveKubernetesCommandConfig({ ...input, ...commandOptions(context) }, undefined, context);
      if (!kube) throw new Error("已取消 Case 列表的环境选择");
      const executor = createKubernetesExecutor(kube);
      const invoke = caseOperationInvoker(context, executor, kube.kubernetes, "doctor case list");
      const directory = discoverTenantDirectory(plugin!.services, (service, extension) =>
        openPluginContext(executor, kube.kubernetes, {
          config: context.profile.pluginConfig, service, endpoint: extension.endpoint, capability: extension,
          signal: context.signal, clients: context.clients, command: "doctor case list identity",
          authorization: context.kubernetes(executor).access,
        }), { commandContext: context });
      return {
        consume: (service, extension) => invoke(service, extension, `bindings ${service.name}/${extension.id}`, { tenantId: input.tenantId }),
        produce: async (service, source) => {
          const producer = caseProducer(source);
          const requestIdentity = producer.requestIdentity ? await resolveCaseProducerIdentity(context, producer, input, directory) : undefined;
          const requestTenantId = producer.requestTenant ? await resolveCaseProducerTenant(context, producer, input, directory) : undefined;
          if ((producer.requestIdentity && !requestIdentity) || (producer.requestTenant && !requestTenantId)) throw new Error("已取消 Case 身份选择");
          useLogger("case").info(`解析 ${service.name}/${source.id} 的 Case URL`);
          return invoke(service, producer, `produce ${service.name}/${source.id}`, {
            tenantId: input.tenantId, requestIdentity, requestTenantId, maxCases: 10,
          });
        },
      } satisfies Omit<CaseListActions, "signal">;
    })();
    const result = await listDoctorCases(catalog, plugin, input, {
      signal: context.signal,
      consume: async (service, extension) => (await access()).consume(service, extension),
      produce: async (service, source) => (await access()).produce(service, source),
    });
    writeOutput(`${context.options.format === "json" ? JSON.stringify(result, null, 2) : formatCaseList(result)}\n`);
    return { status: result.gaps.length ? CommandStatus.Partial : CommandStatus.Ok, output: undefined, artifacts: [] };
  },
});
