// Wire types — must match cli-server-protocol-v0.md.

import type { DbCredentials } from "../command/profile";

export type { DbCredentials } from "../command/profile";

export interface ProfileUpload {
  readonly: boolean;
  kube?: { kubeconfig: string };
  db?: DbCredentials;
  llm?: { provider?: string; endpoint?: string; api_key?: string; model?: string; thinking?: boolean };
}

export interface CreateConnectionResponse {
  connection_id: string;
}

export interface ServerErrorBody {
  error: { code: string; message: string };
}

// Local state (~/.doctor/state.yaml)
export interface ConversationRecord {
  profile: string;
  last_used_at: string;
}

export interface State {
  last_conversation_id?: string;
  conversations: Record<string, ConversationRecord>;
}

// SSE event union (subset CLI cares about; unknown event_types pass through).
export type AgentEventType =
  | "session.created"
  | "session.attached"
  | "run.started"
  | "run.completed"
  | "turn.started"
  | "turn.completed"
  | "text.chunk"
  | "thinking.chunk"
  | "tool_call.started"
  | "tool_call.chunk"
  | "tool_call.completed"
  | "tool_call.result";

export interface AgentEventBase {
  event_id: string;
  event_type: string;        // not narrowed — unknown types pass through
  session_id: string;
  run_id: string | null;
  occurred_at: number;
  trace_id?: string | null;
  // payload fields are event-type-specific; carried as extra props
  [key: string]: unknown;
}

// Resolved CLI flags after commander parsing.
export interface CliFlags {
  profile?: string;
  resume?: string | true;    // true = --resume without value; string = --resume <id>
  server?: boolean;
  config?: string;
  verbose: boolean;
}
