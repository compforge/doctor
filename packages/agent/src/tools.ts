import {
  createBashTool,
  createReadTool,
  type AgentTool,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";

/** Bind Pi's environment-aware tools to the environment selected by the host. */
export function createExecutionTools(env: ExecutionEnv): AgentTool[] {
  const context = { env };
  const read = createReadTool();
  const bash = createBashTool();
  const boundRead: AgentTool<typeof read.parameters> = {
    ...read,
    execute: (toolCallId, params, signal, onUpdate) => (
      read.execute(toolCallId, params, signal, onUpdate, context)
    ),
  };
  const boundBash: AgentTool<typeof bash.parameters> = {
    ...bash,
    execute: (toolCallId, params, signal, onUpdate) => (
      bash.execute(toolCallId, params, signal, onUpdate, context)
    ),
  };

  return [boundRead, boundBash];
}
