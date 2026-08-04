import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadState,
  saveState,
  recordConversation,
  resolveResumeTarget,
} from "../src/app/config/state";
import type { State } from "../src/protocol/types";

function tmpStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), "doctor-state-")), "state.yaml");
}

describe("loadState", () => {
  it("returns empty state when file missing", () => {
    const s = loadState("/tmp/nope-doctor-state.yaml");
    expect(s).toEqual({ conversations: {} });
  });

  it("parses an existing state file", () => {
    const p = tmpStatePath();
    writeFileSync(
      p,
      `last_conversation_id: aaa
conversations:
  aaa:
    profile: ro
    last_used_at: 2026-05-02T10:00:00Z
`,
    );
    const s = loadState(p);
    expect(s.last_conversation_id).toBe("aaa");
    expect(s.conversations.aaa.profile).toBe("ro");
  });
});

describe("recordConversation + saveState round trip", () => {
  it("writes conversation and re-reads it", () => {
    const p = tmpStatePath();
    let s: State = { conversations: {} };
    s = recordConversation(s, "abc", "ro");
    saveState(p, s);

    const s2 = loadState(p);
    expect(s2.last_conversation_id).toBe("abc");
    expect(s2.conversations.abc.profile).toBe("ro");
    expect(s2.conversations.abc.last_used_at).toMatch(/T/);
  });

  it("updates last_used_at on re-record without overwriting profile mismatch", () => {
    let s: State = { conversations: {} };
    s = recordConversation(s, "abc", "ro");
    const ts1 = s.conversations.abc.last_used_at;
    // 1ms wait to guarantee newer timestamp
    const wait = Date.now() + 5;
    while (Date.now() < wait) {}
    s = recordConversation(s, "abc", "ro");
    expect(s.conversations.abc.last_used_at).not.toBe(ts1);
  });
});

describe("resolveResumeTarget", () => {
  const state: State = {
    last_conversation_id: "abc",
    conversations: {
      abc: { profile: "ro", last_used_at: "2026-05-02T10:00:00Z" },
      xyz: { profile: "full", last_used_at: "2026-05-01T10:00:00Z" },
    },
  };

  it("returns last_conversation_id and its profile when resume=true", () => {
    expect(resolveResumeTarget(state, true)).toEqual({ conversationId: "abc", profile: "ro" });
  });

  it("returns specific id and its profile when resume=<id>", () => {
    expect(resolveResumeTarget(state, "xyz")).toEqual({ conversationId: "xyz", profile: "full" });
  });

  it("throws when resume id not in state", () => {
    expect(() => resolveResumeTarget(state, "ghost")).toThrow(/not found/i);
  });

  it("throws when resume=true but no last_conversation_id", () => {
    const empty: State = { conversations: {} };
    expect(() => resolveResumeTarget(empty, true)).toThrow(/no.*conversation/i);
  });
});
