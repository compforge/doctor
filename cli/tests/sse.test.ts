import { describe, expect, it } from "bun:test";
import { parseSseStream } from "../src/protocol/sse";

function streamFrom(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: unknown[] = [];
  for await (const ev of parseSseStream(stream)) out.push(ev);
  return out;
}

describe("parseSseStream", () => {
  it("parses a single complete frame", async () => {
    const frame =
      "event: text.chunk\n" +
      'data: {"event_id":"1","event_type":"text.chunk","session_id":"s","run_id":"r","occurred_at":1,"content":"hi"}\n\n';
    const events = await collect(streamFrom([frame])) as any[];
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("text.chunk");
    expect(events[0].content).toBe("hi");
  });

  it("handles a frame split across multiple chunks", async () => {
    const full =
      'event: text.chunk\ndata: {"event_id":"1","event_type":"text.chunk","session_id":"s","run_id":"r","occurred_at":1,"content":"hello"}\n\n';
    const half = full.length >> 1;
    const events = (await collect(streamFrom([full.slice(0, half), full.slice(half)]))) as any[];
    expect(events.length).toBe(1);
    expect(events[0].content).toBe("hello");
  });

  it("yields multiple frames in one chunk", async () => {
    const f = (id: string, c: string) =>
      `event: text.chunk\ndata: {"event_id":"${id}","event_type":"text.chunk","session_id":"s","run_id":"r","occurred_at":1,"content":"${c}"}\n\n`;
    const events = (await collect(streamFrom([f("1", "a") + f("2", "b")]))) as any[];
    expect(events.map((e) => e.content)).toEqual(["a", "b"]);
  });

  it("skips malformed JSON without crashing", async () => {
    const good = 'event: t\ndata: {"event_id":"1","event_type":"t","session_id":"s","run_id":null,"occurred_at":1}\n\n';
    const bad = "event: t\ndata: {oops not json}\n\n";
    const events = (await collect(streamFrom([bad + good]))) as any[];
    expect(events.length).toBe(1);
    expect(events[0].event_id).toBe("1");
  });

  it("ignores comment lines and empty data", async () => {
    const frame =
      ":heartbeat\n" +
      "event: x\n" +
      "data:\n" +
      "\n" +
      'event: y\ndata: {"event_id":"1","event_type":"y","session_id":"s","run_id":null,"occurred_at":1}\n\n';
    const events = (await collect(streamFrom([frame]))) as any[];
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("y");
  });
});
