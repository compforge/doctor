import { cwd } from "node:process";
import {
  defineCommandDiscovery,
  type CommandContext,
} from "../../command";
import {
  discoverPackageBundles,
  type PackageBundle,
} from "../../infra/target/package-install";
import { terminalStdout } from "../../terminal/output";
import { runInstall } from "../install";
import type { InstallCliOpts } from "../install/model";
import type {
  DebugCliOpts,
  DebugTarget,
} from "./model";
import { latestCreatedDebugEnvironment } from "./runtime";

export interface DebugInstallFollowUp {
  packageTars: string[];
  install: InstallCliOpts;
}

const localPackageBundles = defineCommandDiscovery<readonly PackageBundle[]>(
  "toolkit.packages.local",
);

export function resolveDebugInstallFollowUp(input: {
  interactive: boolean;
  bundles: readonly PackageBundle[];
  opts: DebugCliOpts;
  commandContext: CommandContext;
  target: Pick<DebugTarget, "namespace" | "pod" | "container">;
}): DebugInstallFollowUp | undefined {
  if (!input.interactive || input.bundles.length === 0) return undefined;
  const environment = latestCreatedDebugEnvironment(input.commandContext, {
    namespace: input.target.namespace,
    pod: input.target.pod,
    targetContainer: input.target.container,
  });
  if (!environment?.capabilities.includes("SYS_PTRACE")) return undefined;
  const packageTars = [...new Set(input.bundles.map((bundle) => bundle.path))];
  return {
    packageTars,
    install: {
      // `doctor debug -y` only approves the container deployment; package installation
      // remains a separate mutation and must retain doctor install's own approval gate.
      profile: input.opts.profile,
      config: input.opts.config,
      namespace: input.target.namespace,
      kubeconfig: input.opts.kubeconfig,
      context: input.opts.context,
      pod: environment.pod,
      container: environment.executionContainer,
      program: "gdb",
    },
  };
}

export async function offerDebugInstall(
  target: DebugTarget,
  opts: DebugCliOpts,
  commandContext: CommandContext,
): Promise<number> {
  const directory = cwd();
  const bundles = await commandContext.discover(
    localPackageBundles,
    [directory],
    () => discoverPackageBundles(directory),
  );
  const followUp = resolveDebugInstallFollowUp({
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    bundles,
    opts,
    commandContext,
    target,
  });
  if (!followUp) return 0;

  terminalStdout.info(
    `[debug] 发现 Doctor Toolkit/package tar：${followUp.packageTars.join("、")}\n`
    + `[debug] 检查新建容器 ${followUp.install.pod}/${followUp.install.container} 的 GDB；`
    + "确需安装时将展示方案并单独询问。\n",
  );
  const code = await runInstall(followUp.install, commandContext);
  // Declining this optional follow-up does not undo the debug environment that is already ready.
  return code === 130 ? 0 : code;
}
