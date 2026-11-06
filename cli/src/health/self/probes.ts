import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../../command";
import type { HealthProvider } from "../extensions";
import { runHealthProbes } from "../probe-runner";

/** Self Probes inspect the Service itself without resolving its downstream dependencies. */
export function checkSelfHealthProbes(provider: HealthProvider, context: CommandContext, executor: Executor,
  kubernetes: KubectlOptions & { namespace: string }, bizId?: string) {
  return runHealthProbes(provider, context, executor, kubernetes, async () => ({ bizId, downstreams: [] }));
}
