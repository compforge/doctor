export { gatewayLogsProbe } from "./gateway-logs";
export { httpCallProbe } from "./http-call";
export { mcpCallProbe } from "./mcp-call";

import { gatewayLogsProbe } from "./gateway-logs";
import { httpCallProbe } from "./http-call";
import { mcpCallProbe } from "./mcp-call";

export const mcpProbes = [mcpCallProbe, httpCallProbe, gatewayLogsProbe] as const;
