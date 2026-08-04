// Wire types — must match cli-server-protocol-v0.md.

// DB 凭据：身份（user/password）必填，host/port 由 skill 自寻（多 schema 共用同一 user 的现实）。
// host_override/port_override 是 v0+1 escape hatch，server 端 v0 暂不消费，只占 schema 名字。
export interface DbCredentials {
  user: string;
  password: string;
  host_override?: string;
  port_override?: number;
}

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
  config?: string;
  verbose: boolean;
}
