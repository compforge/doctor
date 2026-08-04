export { buildMcpCoverage } from "./coverage";
export { compareMcpAndHttp } from "./comparison";
export type { McpDetector, McpFinding, McpFindingKind } from "./types";

import { compareMcpAndHttp } from "./comparison";
import type { McpDetector } from "./types";

export const mcpDetectors: readonly McpDetector[] = [compareMcpAndHttp];
