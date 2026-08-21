// Evidence Bundle：一次采集的完整产物目录。
//   <dir>/manifest.json   身份/参数/时间窗/每步状态——机器可消费
//   <dir>/raw/NN-<id>.*   每步原始 stdout（stderr 非空时并入，带分隔标记）
//   <dir>/summary.md      规则层事实摘要——给人看
// 原则：失败步骤也留上下文；原始证据与结论分开（分析产物后续单独落 analysis.md，不覆盖事实）。
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationRisk } from "../command/approval";

export type StepStatus = "ok" | "failed" | "skipped" | "unavailable";
export type OutcomeStatus = "ok" | "partial" | "failed" | "unavailable" | "unnecessary";
export type EvidenceStatus = StepStatus | OutcomeStatus;

// risk 表示该步骤实际执行到的最高副作用等级，而不是命令类别猜测。
export type StepRisk = OperationRisk;

export interface StepInput {
  id: string;
  title: string;
  risk: StepRisk;
  status: StepStatus;
  /** failed/skipped/unavailable 时的原因（降级原因也算证据） */
  reason?: string;
  command?: string[];
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
  stderr?: string;
  /** 已流式落盘的完整原始 stdout；record 时移入 raw/，不经过通用文本截断。 */
  rawFilePath?: string;
  /** raw 文件扩展名，默认 txt */
  ext?: string;
}

export interface StepRecord {
  id: string;
  title: string;
  risk: StepRisk;
  status: EvidenceStatus;
  reason?: string;
  command?: string[];
  exit_code?: number | null;
  duration_ms?: number;
  raw_file?: string;
}

/**
 * 检验项：本次采集打算拿到的一份证据。构造期预印，执行期恰好填一次终态，
 * 收尾时仍空着的自动落 unavailable——"没做"和"没记"因此不可能长得一样。
 *
 * 与工序（走 addStep 追加，如 py-spy-install、approval-*）的区别是**行的类型**，
 * 不是每处都要判断的 status：检验项缺席 = unavailable（需要但没拿到），上游证据
 * 已足够时 = unnecessary；工序缺席 = skipped（这步没走）。
 */
export interface OutcomeDecl {
  id: string;
  title: string;
  risk: StepRisk;
}

/**
 * 检验项有五种终态：完整拿到 / 部分拿到 / 试了但坏了 / 需要但没拿到 / 已证明无需取得。
 * **没有 skipped**——"我们选择不做"是工序的语义；对一份证据而言，选择不做的结果
 * 要么是 unavailable，要么是由上游证据支持的 unnecessary。
 */
/** 填格子时调用方提供的部分；id/title/risk 来自声明，不重复给也不允许改。 */
export type OutcomeFill =
  & Omit<StepInput, "id" | "title" | "risk" | "status">
  & { status: OutcomeStatus };

/** settle 兜底时的 reason。用户大量看到它就说明 doctor 有记账漏洞，不是环境问题。 */
export const OUTCOME_UNREACHED_REASON = "采集流程未到达该步骤（doctor 未记录原因）";

export interface ManifestMeta {
  doctorVersion: string;
  kubectlVersion?: string;
  target: Record<string, unknown>;
  /** Command 选入 Evidence 的可持久化、已脱敏领域 Facts；与 Probe Observations 分开存放。 */
  inspectionFacts: Record<string, unknown>;
  params: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
}

// 单文件上限。超限时保头 + 保尾：头部是命令回显/表头，尾部是最新状态，中段最可弃。
const RAW_CAP_BYTES = 512 * 1024;
const HEAD_KEEP = 16 * 1024;

export function truncateRaw(text: string, cap: number = RAW_CAP_BYTES, headKeep: number = HEAD_KEEP): string {
  if (Buffer.byteLength(text, "utf-8") <= cap) return text;
  const head = text.slice(0, headKeep);
  const tailBudget = cap - headKeep;
  const tail = text.slice(-tailBudget);
  const dropped = Buffer.byteLength(text, "utf-8") - cap;
  return `${head}\n\n...[doctor: truncated ~${dropped} bytes]...\n\n${tail}`;
}

export class EvidenceBundle {
  readonly dir: string;
  private readonly steps: StepRecord[] = [];
  private readonly pending = new Map<string, OutcomeDecl>();
  private readonly filled = new Set<string>();
  private seq = 0;

  /**
   * outcomes 省略时退化成纯追加模式，适合运行时才发现证据 id 的即时查询。
   * 声明了就多两条保证：格子只填一次（fill）、收尾不留空格（settle）。
   */
  constructor(dir: string, outcomes: readonly OutcomeDecl[] = []) {
    this.dir = dir;
    mkdirSync(join(dir, "raw"), { recursive: true });
    for (const outcome of outcomes) this.pending.set(outcome.id, outcome);
  }

  /** 工序流水：执行期追加，同一次采集可以有 0..n 条。 */
  addStep(input: StepInput): StepRecord {
    return this.record(input);
  }

  private record(input: Omit<StepInput, "status"> & { status: EvidenceStatus }): StepRecord {
    this.seq += 1;
    const record: StepRecord = {
      id: input.id,
      title: input.title,
      risk: input.risk,
      status: input.status,
      reason: input.reason,
      command: input.command,
      exit_code: input.exitCode,
      duration_ms: input.durationMs,
    };
    const body = composeRawBody(input.output, input.stderr);
    if (input.rawFilePath) {
      const name = `${String(this.seq).padStart(2, "0")}-${input.id}.${input.ext ?? "txt"}`;
      renameSync(input.rawFilePath, join(this.dir, "raw", name));
      record.raw_file = `raw/${name}`;
    } else if (body) {
      const name = `${String(this.seq).padStart(2, "0")}-${input.id}.${input.ext ?? "txt"}`;
      writeFileSync(join(this.dir, "raw", name), truncateRaw(body), "utf-8");
      record.raw_file = `raw/${name}`;
    }
    this.steps.push(record);
    return record;
  }

  /**
   * 填一个检验项的终态。记录按**执行顺序**进 steps（不是声明顺序），所以 manifest
   * 仍是一条时间线；预印只体现在"漏填会被 settle 抓住"，不体现在数组位置。
   *
   * 重复填 / 填未声明的格子都 throw：这是编程错误，不是环境问题。采集的"单点失败
   * 不丢整次"针对的是探针失败、权限不足这类现实，不包括 doctor 自己记错账——
   * 一份自相矛盾的证据包比没有更糟。经 py-spy 阶梯重构后每个格子只有一处 fill，
   * 这个 throw 是防回归的网，正常不该响。
   */
  fill(id: string, result: OutcomeFill): StepRecord {
    const decl = this.pending.get(id);
    if (!decl) {
      throw new Error(
        this.filled.has(id)
          ? `Evidence 检验项 '${id}' 被填了两次——一次采集内每格只能有一个终态`
          : `Evidence 检验项 '${id}' 未声明——检查构造 EvidenceBundle 时传入的清单`,
      );
    }
    this.pending.delete(id);
    this.filled.add(id);
    return this.record({ id, title: decl.title, risk: decl.risk, ...result });
  }

  /**
   * 把仍空着的检验项落成 unavailable。两种用法：
   *   settle(reason)       —— 单子上剩下的全因这个原因没戏了（如"无 pods/exec 权限"）
   *   settle(reason, ids)  —— 只判这几项死刑（如 pid 定位失败只杀依赖 pid 的项，
   *                           不牵连 metrics / python-heap 这些不需要 pid 的）
   * 已填过的 id 直接跳过，所以调用方不必先判断填没填。
   *
   * 这里**不** throw：走到兜底说明 doctor 没记住原因，但如实记下"这份证据没拿到"
   * 仍然比让它从 manifest 里消失强。
   */
  settle(reason: string = OUTCOME_UNREACHED_REASON, ids?: readonly string[]): void {
    for (const id of ids ?? [...this.pending.keys()]) {
      const decl = this.pending.get(id);
      if (!decl) continue;
      this.pending.delete(id);
      this.filled.add(id);
      this.addStep({
        id: decl.id,
        title: decl.title,
        risk: decl.risk,
        status: "unavailable",
        reason,
      });
    }
  }

  getSteps(): readonly StepRecord[] {
    return this.steps;
  }

  writeManifest(meta: ManifestMeta): void {
    // 写盘前兜底收尾。放这里而不是靠调用方记得调 settle()——理由跟整个 worksheet 一样：
    // 凡是"要记得做"的记账，早晚会忘。
    this.settle();
    const manifest = {
      doctor_version: meta.doctorVersion,
      kubectl_version: meta.kubectlVersion,
      target: meta.target,
      inspection_facts: meta.inspectionFacts,
      params: meta.params,
      started_at: meta.startedAt,
      finished_at: meta.finishedAt,
      steps: this.steps,
    };
    writeFileSync(join(this.dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  }

  writeSummary(markdown: string): void {
    writeFileSync(join(this.dir, "summary.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf-8");
  }
}

function composeRawBody(stdout?: string, stderr?: string): string {
  const out = stdout ?? "";
  const err = (stderr ?? "").trim();
  if (!out && !err) return "";
  if (!err) return out;
  return `${out}\n----- stderr -----\n${err}\n`;
}
