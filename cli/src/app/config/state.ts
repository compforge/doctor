import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { State } from "../../protocol";

export function loadState(path: string): State {
  if (!existsSync(path)) {
    return { conversations: {} };
  }
  const raw = readFileSync(path, "utf8");
  const data = (parseYaml(raw) ?? {}) as Partial<State>;
  return {
    last_conversation_id: data.last_conversation_id,
    conversations: data.conversations ?? {},
  };
}

export function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(state), "utf8");
}

export function recordConversation(
  state: State,
  conversationId: string,
  profile: string,
): State {
  return {
    last_conversation_id: conversationId,
    conversations: {
      ...state.conversations,
      [conversationId]: {
        profile,
        last_used_at: new Date().toISOString(),
      },
    },
  };
}

export interface ResumeTarget {
  conversationId: string;
  profile: string;
}

export function resolveResumeTarget(state: State, resume: string | true): ResumeTarget {
  const id = resume === true ? state.last_conversation_id : resume;
  if (!id) {
    throw new Error("--resume given but no conversation history found in state");
  }
  const rec = state.conversations[id];
  if (!rec) {
    throw new Error(`conversation ${id} not found in state`);
  }
  return { conversationId: id, profile: rec.profile };
}
