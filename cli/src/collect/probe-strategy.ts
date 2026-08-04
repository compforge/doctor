import type {
  ProbeStrategy,
  ProbeStrategyAttempt,
  ProbeStrategyStatus,
} from "./protocol";

export interface ProbeStrategyRun<Result> {
  attempts: readonly ProbeStrategyAttempt<Result>[];
  final?: ProbeStrategyAttempt<Result>;
}

function validateStrategies<Result, Facts, Ctx>(
  strategies: readonly ProbeStrategy<Result, Facts, Ctx>[],
): void {
  const ids = new Set<string>();
  for (const strategy of strategies) {
    if (ids.has(strategy.id)) throw new Error(`duplicate probe strategy id: ${strategy.id}`);
    ids.add(strategy.id);
  }
}

function statusLabel(status: ProbeStrategyStatus): string {
  switch (status) {
    case "succeeded": return "成功";
    case "failed": return "失败";
    case "declined": return "未授权";
  }
}

/**
 * 按注册顺序执行一个 Probe 的策略升级链。
 *
 * runner 只执行每条策略给出的 stop / continue 决策，不吞异常，也不替领域判断更高影响
 * 的路径是否仍有价值；因此副作用授权、异常降级和最终 Observation 仍由具体 Probe 负责。
 */
export async function runProbeStrategies<Result, Facts, Ctx = void>(
  strategies: readonly ProbeStrategy<Result, Facts, Ctx>[],
  ctx: Ctx,
  facts: Facts,
  log: (line: string) => void = () => {},
): Promise<ProbeStrategyRun<Result>> {
  validateStrategies(strategies);
  const attempts: ProbeStrategyAttempt<Result>[] = [];

  for (const strategy of strategies) {
    log(`[collect] 执行 ProbeStrategy：${strategy.id}…`);
    const outcome = await strategy.run(ctx, facts, attempts);
    const attempt = { strategyId: strategy.id, ...outcome };
    attempts.push(attempt);
    const decision = outcome.decision === "continue" ? "继续升级" : "停止升级";
    const reason = outcome.reason ? `：${outcome.reason}` : "";
    log(`[collect] ProbeStrategy 完成：${strategy.id}（${statusLabel(outcome.status)}，${decision}）${reason}`);
    if (outcome.decision === "stop") return { attempts, final: attempt };
  }

  return { attempts, final: attempts.at(-1) };
}
