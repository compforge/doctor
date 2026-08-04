import { infra } from "../../infra";
import type { DebugCapability, DebugGdbFact } from "../../infra/target/debug";
import { terminalStdout } from "../../terminal/output";
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
  if (gdb.pythonScripting) {
    terminalStdout.success("[debug] gdb: ready（支持 Python scripting）\n");
    return gdb;
  }
  if (gdb.available) {
    terminalStdout.warning(`[debug] gdb: ${gdb.reason}；无法用于 PyHeap dump\n`);
    return gdb;
  }

  terminalStdout.warning(
    `[debug] gdb: 未找到；如需补齐，请执行 doctor install -n ${target.namespace}`
    + ` -p ${target.pod} -c ${container}\n`,
  );
  return gdb;
}

export async function reportDebugCapabilities(
  target: DebugTarget,
  container: string,
  capabilities: readonly DebugCapability[],
): Promise<void> {
  terminalStdout.success(
    `[debug] container ready: ${target.pod}/${container}`
    + `（PID namespace=${target.container}，capabilities=${capabilities.join(",")}）\n`,
  );
  const gdb = capabilities.includes("SYS_PTRACE")
    ? await ensureGdb(target, container)
    : undefined;
  const manifest = await infra.target.debugEngine.inspectReadiness(
    target.executor,
    target.pod,
    container,
  );
  if (manifest.ok) {
    terminalStdout.write(`[debug] tools: doctor-debug image manifest ready\n${manifest.stdout}`);
  } else if (capabilities.includes("SYS_PTRACE")) {
    if (gdb?.pythonScripting) {
      terminalStdout.write("[debug] PyHeap: GDB 前置已就绪；doctor mem 将按需上传 PyHeap dumper\n");
    } else {
      terminalStdout.warning("[debug] PyHeap: unavailable（缺少支持 Python scripting 的 GDB）\n");
    }
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
  if (existing) terminalStdout.info(existing);
  if (!resolved.ok) return undefined;

  terminalStdout.write(
    `[debug] reuse ${target.pod}/${resolved.value.executionContainer}`
    + ` (image=${resolved.value.image})\n`,
  );
  await reportDebugCapabilities(
    target,
    resolved.value.executionContainer,
    requiredCapabilities,
  );
  return resolved.value.executionContainer;
}
