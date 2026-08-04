import { describe, expect, it } from "bun:test";
import { ServerError, mapErrorMessage } from "../src/protocol/errors";

describe("ServerError", () => {
  it("captures code, message, and http status", () => {
    const e = new ServerError(404, "connection_not_found", "no such cid");
    expect(e.code).toBe("connection_not_found");
    expect(e.status).toBe(404);
    expect(e.message).toBe("no such cid");
    expect(e instanceof Error).toBe(true);
  });
});

describe("mapErrorMessage", () => {
  it("maps known codes to localized text", () => {
    expect(mapErrorMessage(new ServerError(404, "connection_not_found", "x"))).toMatch(/connection/i);
    expect(mapErrorMessage(new ServerError(409, "conversation_busy", "x"))).toMatch(/上一轮|busy|运行/i);
    expect(mapErrorMessage(new ServerError(502, "llm_unavailable", "x"))).toMatch(/llm|不可用/i);
  });

  it("falls back to raw message for unknown codes", () => {
    const out = mapErrorMessage(new ServerError(500, "weird_thing", "boom"));
    expect(out).toContain("boom");
  });

  it("handles non-server errors", () => {
    const out = mapErrorMessage(new Error("network down"));
    expect(out).toContain("network down");
  });
});
