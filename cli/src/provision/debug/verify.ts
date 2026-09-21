import { infra } from "../../infra";
import type { DebugCapability, DebugGdbFact } from "../../infra/target/debug";
import { writeOutput } from "../../terminal/output";
import { useLogger } from "../../terminal/log";
import { formatExistingDebugContainers } from "./inspect";
import type { DebugTarget } from "./model";

async function ensureGdb(
  target: DebugTarget,
  container: string,
): Promise<DebugGdbFact> {
  const gdb = await infra.target.debugEngine.inspectGdb(
    target.executor,
    target.pod,
    container,
  );
  if (gdb.available && gdb.inferiorCall) {
    useLogger("debug").success("gdb: ready（inferior call 验收通过）");
    return gdb;
  }
  if (gdb.available) {
    useLogger("debug").warn(`gdb: ${gdb.reason}`);
    return gdb;
  }

  useLogger("debug").warn(`gdb: 未找到；如需补齐，请执行 doctor install -n ${target.namespace}`
    + ` -p ${target.pod} -c ${container}`);
  return gdb;
}

export async function reportDebugCapabilities(
  target: DebugTarget,
  container: string,
  capabilities: readonly DebugCapability[],
): Promise<void> {
  useLogger("debug").success(`container ready: ${target.pod}/${container}`
    + `（PID namespace=${target.container}，capabilities=${capabilities.join(",")}）`);
  if (capabilities.includes("SYS_PTRACE")) await ensureGdb(target, container);
  const manifest = await infra.target.debugEngine.inspectReadiness(
    target.executor,
    target.pod,
    container,
  );
  if (manifest.ok) {
    writeOutput(`[debug] tools: doctor-debug image manifest ready\n${manifest.stdout}`);
  }
}

export async function reuseReadyDebugEnvironment(
  target: DebugTarget,
  requiredCapabilities: readonly DebugCapability[],
): Promise<string | undefined> {
  const facts = infra.target.debugEngine.inspectEnvironments(
    target.podJson,
    target.container,
  );
  const resolved = infra.target.debugEngine.resolveEnvironment(facts, requiredCapabilities);
  const existing = formatExistingDebugContainers(
    target.pod,
    facts,
    resolved.ok ? resolved.value.executionContainer : undefined,
  );
  if (existing) useLogger().info(existing);
  if (!resolved.ok) return undefined;

  useLogger("debug").info(`reuse ${target.pod}/${resolved.value.executionContainer}`
    + ` (image=${resolved.value.image})`);
  await reportDebugCapabilities(
    target,
    resolved.value.executionContainer,
    requiredCapabilities,
  );
  return resolved.value.executionContainer;
}
