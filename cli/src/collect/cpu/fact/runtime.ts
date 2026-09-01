import { writeErrorLog } from "../../../app/error-log";
import type { ContainerInfo, TargetPod } from "../../../infra/k8s/target";
import { fillFromExec } from "../../exec-step";
import { pickPid } from "../../fact/process";
import { parsePtraceFacts, podDeclaresSysPtrace, ptraceFactsCmd } from "../../fact/ptrace";
import type { Inspect } from "../../inspection";
import type { CpuCommandContext } from "../context";
import type { CpuDiagnosisFacts } from "./model";
import { cpuPythonFactsCmd, parseCpuPythonFacts } from "./python";
import { collectedFact } from "../../protocol";

export function makeCpuTargetInspect(
  pod: TargetPod,
  container: ContainerInfo,
): Inspect<CpuDiagnosisFacts, CpuCommandContext> {
  return {
    id: "cpu-target",
    run: async () => ({ target: collectedFact("cpu.target", "cpu-target", { pod, container }) }),
  };
}

export function makeCpuRuntimeInspect(): Inspect<CpuDiagnosisFacts, CpuCommandContext> {
  return {
    id: "cpu-runtime",
    dependsOn: ["process-scan"],
    run: async (ctx, facts) => {
      if (!facts.processScan) {
        if (facts.kubernetes?.podsExec && facts.container?.python3 && facts.container?.proc) {
          ctx.bundle.settle("进程扫描失败", ["cpu-python-facts", "ptrace-facts", "py-spy-dump"]);
        } else {
          ctx.bundle.settle("缺少 pods/exec、python3 或 /proc", [
            "platform-facts",
            "process-scan",
            "cpu-python-facts",
            "ptrace-facts",
            "py-spy-dump",
          ]);
        }
        return {};
      }

      const picked = pickPid(facts.processScan, ctx.config.pidFlag);
      if (!picked.ok) {
        ctx.notes.push(picked.reason);
        ctx.bundle.settle(picked.reason, ["cpu-python-facts", "ptrace-facts", "py-spy-dump"]);
        return {};
      }
      if (picked.note) ctx.notes.push(picked.note);

      const produced: Partial<CpuDiagnosisFacts> = {};
      const pythonFacts = await ctx.exec.exec(ctx.target, cpuPythonFactsCmd(), { timeoutMs: 20_000 });
      fillFromExec(ctx.bundle, "cpu-python-facts", pythonFacts, "json");
      if (pythonFacts.ok) {
        try {
          const parsed = parseCpuPythonFacts(pythonFacts.stdout);
          if (parsed) {
            produced.pythonProcess = collectedFact("cpu.python-process", "cpu-runtime", parsed);
          }
        } catch (error) {
          writeErrorLog(error, "doctor cpu/parse-python-facts");
          ctx.notes.push(`py-spy 运行环境 Facts 解析失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const ptrace = await ctx.exec.exec(ctx.target, ptraceFactsCmd(picked.value), { timeoutMs: 20_000 });
      fillFromExec(ctx.bundle, "ptrace-facts", ptrace, "json");
      if (ptrace.ok) {
        try {
          produced.ptrace = collectedFact("cpu.ptrace", "cpu-runtime", parsePtraceFacts(
            ptrace.stdout,
            podDeclaresSysPtrace(ctx.podJson, ctx.container.name),
          ));
        } catch (error) {
          writeErrorLog(error, "doctor cpu/parse-ptrace-facts");
          ctx.notes.push(`ptrace Facts 解析失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return produced;
    },
  };
}
