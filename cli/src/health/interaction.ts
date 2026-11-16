import { defineCommandDecision, type CommandContext } from "../command";
import { approveAll, type ApprovalDecision, type ApprovalGate, type ApprovalRequest } from "../command/approval";
import { resolveApprovalGate } from "../terminal/approval";
import { isInteractive } from "../terminal/policy";
import { promptListedChoice } from "../terminal/selection";
import { writeOutput } from "../terminal/output";

const dependencyApproval = defineCommandDecision<ApprovalDecision>("health.dependency-approval");

/** @spec A declined item is skipped; ending a session never grants approval to later items. */
export class HealthInteraction {
  stopped = false;
  constructor(private readonly context: CommandContext,
    private readonly interactive = isInteractive(),
    private readonly prompt: typeof promptListedChoice = promptListedChoice) {}

  approveOnce(key: string, request: ApprovalRequest): ReturnType<ApprovalGate> {
    return this.context.decide(dependencyApproval, [key], () => this.approve(request));
  }

  readonly approve: ApprovalGate = async (request: ApprovalRequest) => {
    if (this.stopped) return { approved: false, source: "prompt" };
    if (this.context.options.yes) return resolveApprovalGate(this.context.options)(request);
    if (!this.interactive) return request.risk === "observe" ? approveAll() : resolveApprovalGate(this.context.options)(request);
    writeOutput(`\n${request.title}\n目标：${request.target}\n`);
    if (request.purpose) writeOutput(`${request.purpose}\n`);
    for (const detail of request.impact) writeOutput(`  ${detail}\n`);
    const choice = await this.prompt({ question: "执行？[y] 执行 / [n] 跳过 / [q] 结束巡检（默认 n）：",
      emptyValue: "skip" as const,
      match: answer => /^(y|yes)$/i.test(answer) ? "run" as const
        : /^(n|no)$/i.test(answer) ? "skip" as const : /^(q|quit)$/i.test(answer) ? "stop" as const : undefined,
      invalidMessage: "请输入 y、n 或 q",
    });
    this.stopped = choice === "stop" || choice === undefined;
    return { approved: choice === "run", source: "prompt" };
  };
}
