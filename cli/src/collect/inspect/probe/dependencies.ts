import type { Toolchain } from "@compforge/doctor-plugin";
import type { ExecResult, Executor } from "../../../infra/k8s/executor";
import type { Probe } from "../../protocol";
import { PROBE_RUNNABLE, probeUnavailable } from "../../protocol";
import type {
  DependencyInventoryObservation,
  InspectCommandContext,
  InspectConfig,
  InspectDependencyTarget,
  InspectFacts,
  InspectObservation,
  RuntimeDependency,
} from "../model";

const DEPENDENCY_TIMEOUT_MS = 20_000;
const MAX_DEPENDENCIES = 5_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const PYTHON_DEPENDENCIES_SCRIPT = `
import json
import platform
from importlib.metadata import distributions

packages = {}
for distribution in distributions():
    name = distribution.metadata.get("Name")
    if name:
        packages[name] = distribution.version
items = [{"name": name, "version": packages[name]} for name in sorted(packages, key=str.lower)]
print(json.dumps({
    "runtimeVersion": platform.python_version(),
    "dependencies": items[:${MAX_DEPENDENCIES}],
    "truncated": len(items) > ${MAX_DEPENDENCIES},
}))
`.trim();

const NODE_DEPENDENCIES_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const limit = ${MAX_DEPENDENCIES};
const packages = new Map();
const queue = [path.join(process.cwd(), "node_modules")];
const visited = new Set();

function enqueuePackage(directory) {
  let real;
  try { real = fs.realpathSync(directory); } catch { return; }
  if (visited.has(real)) return;
  visited.add(real);
  try {
    const value = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8"));
    if (typeof value.name === "string" && typeof value.version === "string") {
      packages.set(value.name, value.version);
    }
  } catch {}
  queue.push(path.join(real, "node_modules"));
}

while (queue.length && packages.size < limit) {
  const root = queue.shift();
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (packages.size >= limit) break;
    const directory = path.join(root, entry.name);
    if (entry.name === ".pnpm") {
      let slots = [];
      try { slots = fs.readdirSync(directory); } catch {}
      for (const slot of slots) queue.push(path.join(directory, slot, "node_modules"));
    } else if (entry.name.startsWith("@")) {
      let scoped = [];
      try { scoped = fs.readdirSync(directory); } catch {}
      for (const name of scoped) enqueuePackage(path.join(directory, name));
    } else if (!entry.name.startsWith(".")) {
      enqueuePackage(directory);
    }
  }
}

const dependencies = [...packages.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, version]) => ({ name, version }));
process.stdout.write(JSON.stringify({
  runtimeVersion: process.version,
  dependencies,
  truncated: queue.length > 0,
}));
`.trim();

interface DependencyPayload {
  runtimeVersion?: string;
  dependencies: RuntimeDependency[];
  truncated?: boolean;
}

interface DependencyCapture extends DependencyPayload {
  status: "collected" | "unavailable";
  reason?: string;
  execution?: ExecResult;
}

function failureReason(result: ExecResult): string {
  if (result.timedOut) return `采集超时（${DEPENDENCY_TIMEOUT_MS / 1_000}s）`;
  return result.stderr.trim().split("\n")[0]
    || `目标命令退出码 ${result.exitCode ?? "unknown"}`;
}

function normalizeDependencies(value: unknown): RuntimeDependency[] {
  if (!Array.isArray(value)) throw new Error("依赖采集输出缺少 dependencies 数组");
  const byName = new Map<string, RuntimeDependency>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const name = "name" in item && typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    const version = "version" in item && typeof item.version === "string"
      ? item.version.trim() || undefined
      : undefined;
    byName.set(name, { name, version });
    if (byName.size >= MAX_DEPENDENCIES) break;
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function parseDependencyPayload(raw: string): DependencyPayload {
  if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error(`依赖采集输出超过 ${MAX_OUTPUT_BYTES / 1024 / 1024} MiB 上限`);
  }
  const value = JSON.parse(raw) as Record<string, unknown>;
  return {
    runtimeVersion: typeof value.runtimeVersion === "string" ? value.runtimeVersion : undefined,
    dependencies: normalizeDependencies(value.dependencies),
    truncated: value.truncated === true || undefined,
  };
}

export function parseGoDependencyOutput(raw: string): DependencyPayload {
  const dependencies: RuntimeDependency[] = [];
  let runtimeVersion: string | undefined;
  for (const line of raw.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (!runtimeVersion) runtimeVersion = columns.find((column) => /^go\d+\.\d+/.test(column));
    if ((columns[0] === "mod" || columns[0] === "dep") && columns[1]) {
      dependencies.push({ name: columns[1], version: columns[2] });
    }
  }
  return {
    runtimeVersion,
    dependencies: normalizeDependencies(dependencies),
  };
}

async function runJsonCollector(
  executor: Executor,
  target: InspectDependencyTarget,
  command: string[],
): Promise<DependencyCapture> {
  const execution = await executor.exec(
    { pod: target.pod, container: target.container },
    command,
    { timeoutMs: DEPENDENCY_TIMEOUT_MS },
  );
  if (!execution.ok) {
    return { status: "unavailable", dependencies: [], reason: failureReason(execution), execution };
  }
  try {
    return { status: "collected", ...parseDependencyPayload(execution.stdout), execution };
  } catch (error) {
    return {
      status: "unavailable",
      dependencies: [],
      reason: `无法解析依赖清单：${error instanceof Error ? error.message : String(error)}`,
      execution,
    };
  }
}

async function collectDependencies(
  executor: Executor,
  target: InspectDependencyTarget,
  toolchain: Toolchain,
): Promise<DependencyCapture> {
  if (toolchain.executionPlatform === "python") {
    return runJsonCollector(executor, target, ["python3", "-c", PYTHON_DEPENDENCIES_SCRIPT]);
  }
  if (toolchain.executionPlatform === "node") {
    return runJsonCollector(executor, target, ["node", "-e", NODE_DEPENDENCIES_SCRIPT]);
  }
  if (toolchain.executionPlatform === "go-native") {
    const execution = await executor.exec(
      { pod: target.pod, container: target.container },
      ["go", "version", "-m", "/proc/1/exe"],
      { timeoutMs: DEPENDENCY_TIMEOUT_MS },
    );
    if (!execution.ok) {
      return { status: "unavailable", dependencies: [], reason: failureReason(execution), execution };
    }
    return { status: "collected", ...parseGoDependencyOutput(execution.stdout), execution };
  }
  return {
    status: "unavailable",
    dependencies: [],
    reason: `Core 暂未提供 ${toolchain.executionPlatform} 依赖采集器`,
  };
}

function targetFromFacts(
  facts: InspectFacts,
  target: InspectDependencyTarget,
): InspectDependencyTarget | undefined {
  if (facts.dependencyTargets.status !== "collected") return undefined;
  return facts.dependencyTargets.targets.find((item) => item.id === target.id);
}

export function makeDependencyInventoryProbe(
  target: InspectDependencyTarget,
): Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext> {
  return {
    id: target.id,
    evaluate: (facts) => targetFromFacts(facts, target)
      ? PROBE_RUNNABLE
      : probeUnavailable(`${target.services.join(", ")} 的依赖采集目标已失效`),
    onUnavailable: (ctx, reason) => ctx.bundle.addStep({
      id: target.id,
      title: `${target.services.join(", ")} 应用依赖`,
      risk: "observe",
      status: "unavailable",
      reason,
    }),
    run: async (ctx) => {
      const capture = await collectDependencies(ctx.executor, target, target.toolchain);
      const observation: DependencyInventoryObservation = {
        id: target.id,
        kind: "dependency-inventory",
        services: target.services,
        pod: target.pod,
        container: target.container,
        image: target.image,
        imageId: target.imageId,
        toolchain: target.toolchain,
        status: capture.status,
        runtimeVersion: capture.runtimeVersion,
        dependencies: capture.dependencies,
        truncated: capture.truncated,
        reason: capture.reason,
      };
      ctx.bundle.addStep({
        id: target.id,
        title: `${target.services.join(", ")} 应用依赖`,
        risk: "observe",
        status: capture.status === "collected" ? "ok" : "unavailable",
        reason: capture.reason,
        command: capture.execution?.command,
        exitCode: capture.execution?.exitCode,
        durationMs: capture.execution?.durationMs,
        output: JSON.stringify(observation, null, 2),
        ext: "json",
      });
      return [observation];
    },
  };
}
