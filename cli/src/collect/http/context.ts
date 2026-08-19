import type { CommandContext } from "../../command";
import type { InspectHttpEndpoint, SendHttp } from "../../infra/http";
import type { EvidenceBundle } from "../evidence";
import type { HttpExecutionTarget } from "../shared/http/model";

export interface HttpCommandConfig {
  intervalMs: number;
}

export interface HttpCommandContext {
  command: CommandContext;
  config: HttpCommandConfig;
  target: HttpExecutionTarget;
  inspectEndpoint: InspectHttpEndpoint;
  staging: string;
  bundle: EvidenceBundle;
  sendHttp: SendHttp;
  lastRound: number;
  log: (line: string) => void;
}
