import { createBashTool, createReadTool } from "@earendil-works/pi-agent-core";

/** Pi resolves the host-owned execution environment for each tool invocation. */
export function createExecutionTools() {
  return [createReadTool(), createBashTool()] as const;
}
