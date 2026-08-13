import {
  defineExecutionRecord,
  type CommandContext,
} from "../../command";
import type { DebugCapability } from "../../infra/target/debug";

export interface CreatedDebugEnvironment {
  readonly namespace: string;
  readonly pod: string;
  readonly targetContainer: string;
  readonly executionContainer: string;
  readonly capabilities: readonly DebugCapability[];
}

const createdDebugEnvironment = defineExecutionRecord<CreatedDebugEnvironment>(
  "debug.environment.created",
);

function debugTargetScope(
  target: Pick<CreatedDebugEnvironment, "namespace" | "pod" | "targetContainer">,
): readonly string[] {
  return [target.namespace, target.pod, target.targetContainer];
}

export function recordCreatedDebugEnvironment(
  context: CommandContext,
  environment: CreatedDebugEnvironment,
): void {
  context.record(createdDebugEnvironment, debugTargetScope(environment), environment);
}

export function latestCreatedDebugEnvironment(
  context: CommandContext,
  target: Pick<CreatedDebugEnvironment, "namespace" | "pod" | "targetContainer">,
): CreatedDebugEnvironment | undefined {
  return context.latestRecord(createdDebugEnvironment, debugTargetScope(target));
}
