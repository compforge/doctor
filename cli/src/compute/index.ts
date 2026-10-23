import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandInputError, CommandStatus, defineCommand, type CommandInput } from "../command";
import { commandOptions, type CommandHostOption } from "../command/options";
import { createKubernetesExecutor, resolveKubernetesCommandConfig, type KubernetesCommandInput } from "../command/kubernetes-target";
import { kubernetesClientSource } from "../infra/k8s/resources";
import { bindKubernetesEnvironment } from "../infra/k8s/environment";
import { serializeEvidence } from "../collect/serialize";
import { renderEvidence } from "../report/evidence";
import { useLogger } from "../terminal/log";
import { computeServices, computeStatus, runCompute, type ComputeResult } from "./flow";
import { buildComputeHtml, computeText } from "./report";

export interface ComputeCliOpts extends KubernetesCommandInput {
  services?: readonly string[];
  timeout?: string;
  maxPods?: string;
  maxNodes?: string;
  output?: string;
  format?: string;
}
export type ComputeInput = CommandInput & Omit<ComputeCliOpts, CommandHostOption>;

export function computeLimits(input: ComputeInput) {
  const positive = (value: string | undefined, fallback: number, label: string, max: number) => {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) throw new CommandInputError(`${label} 必须是 1..${max} 的整数`);
    return parsed;
  };
  return { timeoutMs: positive(input.timeout, 30, "--timeout", 600) * 1000,
    maxPods: positive(input.maxPods, 1000, "--max-pods", 100000),
    maxNodes: positive(input.maxNodes, 500, "--max-nodes", 10000), pageSize: 200 };
}

type Preparation = {
  services: ReturnType<typeof computeServices>;
  kube: NonNullable<Awaited<ReturnType<typeof resolveKubernetesCommandConfig>>>;
  limits: ReturnType<typeof computeLimits>;
};

export const computeCommand = defineCommand<ComputeInput, ComputeResult, Preparation>({
  name: "doctor compute",
  validate: input => { computeLimits(input); },
  prepare: async (context, input) => {
    if (context.options.format?.trim() === "summary" && context.options.output !== undefined) {
      throw new CommandInputError("--format summary 不支持 --output，请选择 html/bundle/manifest/default");
    }
    const services = computeServices(await context.resolvePlugin(), input.services);
    await context.ensureEnvironment({ kubernetes: true });
    const kube = await resolveKubernetesCommandConfig({ ...commandOptions(context), ...input,
      ...(!services.length ? { interactive: false } : {}) }, undefined, context);
    return kube ? { services, kube, limits: computeLimits(input) } : undefined;
  },
  run: async (context, { services, kube, limits }) => {
    const executor = createKubernetesExecutor(kube);
    const { environment } = await context.environment(executor);
    const client = await context.clients.get(kubernetesClientSource(bindKubernetesEnvironment(kube.kubernetes, environment)));
    const directory = mkdtempSync(join(tmpdir(), "doctor-compute-"));
    context.artifacts.add({ command: "compute", path: directory });
    let snapshot: ComputeResult | undefined;
    const save = (result: ComputeResult) => {
      snapshot = result;
      writeFileSync(join(directory, "diagnosis.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
      writeFileSync(join(directory, "summary.md"), computeText(result), { mode: 0o600 });
    };
    try {
      await runCompute({ access: client.clusterResources(), services, namespace: kube.kubernetes.namespace,
        options: { ...limits, environment: environment.name, signal: context.signal }, checkpoint: save,
        progress: message => useLogger("compute").info(message) });
    } catch (error) {
      if (!context.signal.aborted) throw error;
    } finally {
      // Root delivery owns stdout for every format, including cancellation snapshots.
      if (snapshot) save(snapshot);
    }
    return { status: context.signal.aborted ? CommandStatus.Cancelled : computeStatus(snapshot!),
      output: snapshot!, artifacts: context.artifacts.list() };
  },
  reportName: (_input, result) => result.output ? `doctor-compute-${result.output.startedAt.replace(/[:.]/g, "-")}` : undefined,
  serialize: async (context, result) => {
    const artifacts = result.artifacts.filter(artifact => artifact.command === "compute");
    return serializeEvidence(context, artifacts, new Map(artifacts.map(artifact => [artifact.id,
      { title: "Compute", execution: { status: result.status } }])));
  },
  render: (context, result) => renderEvidence(context, result, { command: "compute", title: "Compute",
    scope: "集群容量 / Service Workload 资源", render: artifact => context.write(artifact,
      buildComputeHtml(context.json<ComputeResult>(artifact, "diagnosis.json"))) }),
});
