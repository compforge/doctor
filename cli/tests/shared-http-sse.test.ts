import { describe, expect, test } from "bun:test";
import {
  SseCaptureObserver,
  type ObservedSseFrame,
} from "../src/collect/shared/http/sse-observation";

describe("shared HTTP SSE observation", () => {
  test("保留通用 frame 时间线、显式 event 与 DONE 终态", () => {
    const observed: ObservedSseFrame[] = [];
    const observer = new SseCaptureObserver((frame) => observed.push(frame));

    observer.push(
      new TextEncoder().encode('event: text\ndata: {"event":"payload-event","content":"a"}\n\n'),
      1_000,
    );
    observer.push(
      new TextEncoder().encode('data: {"content":"b"}\n\ndata: [DONE]\n\n'),
      1_250,
    );
    const result = observer.finish();

    expect(result).toMatchObject({
      frameCount: 3,
      jsonEventCount: 2,
      incompleteFrame: false,
      timeline: {
        firstFrameAt: "1970-01-01T00:00:01.000Z",
        lastFrameAt: "1970-01-01T00:00:01.250Z",
        durationMs: 250,
        p95GapMs: 250,
        maxGapMs: 250,
        terminalReceived: true,
      },
    });
    expect(result.frames.map((frame) => ({
      event: frame.event,
      kind: frame.dataKind,
    }))).toEqual([
      { event: "text", kind: "json" },
      { event: undefined, kind: "json" },
      { event: undefined, kind: "done" },
    ]);
    expect(observed.map((frame) => frame.terminal)).toEqual([false, false, true]);
    expect(observed[0]?.parsedData).toMatchObject({ content: "a" });
  });

  test("非 JSON data 仍进入通用时间线，尾部半帧明确标记不完整", () => {
    const observer = new SseCaptureObserver();
    observer.push(new TextEncoder().encode("data: plain text\n\n"), 2_000);
    observer.push(new TextEncoder().encode("data: partial"), 2_100);

    const result = observer.finish();

    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({ dataKind: "text" });
    expect(result.incompleteFrame).toBe(true);
    expect(result.timeline.terminalReceived).toBe(false);
  });
});
