import type {
  SseFrameSummary,
  SseTimelineSummary,
} from "./model";

export interface ObservedSseFrame {
  receivedAtMs: number;
  event?: string;
  data: string;
  parsedData?: unknown;
  terminal: boolean;
}

export interface SseCaptureObservation {
  frameCount: number;
  jsonEventCount: number;
  incompleteFrame: boolean;
  frames: readonly SseFrameSummary[];
  timeline: SseTimelineSummary;
}

/** 只建立无正文的 frame 索引；事件含义由 HTTP detector 判读。 */
export class SseCaptureObserver {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private frameCount = 0;
  private jsonEventCount = 0;
  private readonly frames: SseFrameSummary[] = [];

  constructor(
    private readonly onFrame?: (frame: ObservedSseFrame) => void,
  ) {}

  push(chunk: Uint8Array, receivedAtMs: number): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const boundary = /\r?\n\r?\n/;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.buffer)) !== null) {
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.observeFrame(frame, receivedAtMs);
    }
  }

  finish(): SseCaptureObservation {
    this.buffer += this.decoder.decode();
    return {
      frameCount: this.frameCount,
      jsonEventCount: this.jsonEventCount,
      incompleteFrame: this.buffer.trim().length > 0,
      frames: this.frames,
      timeline: summarizeTimeline(this.frames),
    };
  }

  private observeFrame(frame: string, receivedAtMs: number): void {
    const lines = frame.split("\n").map((line) => line.replace(/\r$/, ""));
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) return;
    this.frameCount += 1;

    const data = dataLines.join("\n");
    const terminal = data.trim() === "[DONE]";
    let payload: unknown;
    if (!terminal) {
      try {
        payload = JSON.parse(data);
      } catch {
        payload = undefined;
      }
    }
    const objectPayload = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : undefined;
    if (objectPayload) this.jsonEventCount += 1;
    const explicitEvent = lines.find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trimStart();
    const summary: SseFrameSummary = {
      receivedAt: new Date(receivedAtMs).toISOString(),
      event: explicitEvent || (objectPayload ? stringField(objectPayload, "event") : undefined),
      dataBytes: Buffer.byteLength(data),
      dataKind: terminal ? "done" : objectPayload ? "json" : "text",
      timestamp: objectPayload ? numberField(objectPayload, "timestamp") : undefined,
      code: objectPayload ? stringField(objectPayload, "code") : undefined,
      traceId: objectPayload ? stringField(objectPayload, "trace_id") : undefined,
      messageId: objectPayload ? stringField(objectPayload, "message_id") : undefined,
    };
    this.frames.push(summary);
    this.onFrame?.({
      receivedAtMs,
      event: summary.event,
      data,
      parsedData: payload,
      terminal,
    });
  }
}

function percentile(values: readonly number[], ratio: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function summarizeTimeline(frames: readonly SseFrameSummary[]): SseTimelineSummary {
  const received = frames.map((frame) => Date.parse(frame.receivedAt));
  const gaps = received.slice(1).map((value, index) => Math.max(0, value - received[index]!));
  const first = received[0];
  const last = received.at(-1);
  return {
    firstFrameAt: first === undefined ? undefined : new Date(first).toISOString(),
    lastFrameAt: last === undefined ? undefined : new Date(last).toISOString(),
    durationMs: first === undefined || last === undefined ? undefined : last - first,
    p95GapMs: percentile(gaps, 0.95),
    maxGapMs: gaps.length ? Math.max(...gaps) : undefined,
    terminalReceived: frames.some((frame) => frame.dataKind === "done"),
  };
}

function stringField(payload: object, field: string): string | undefined {
  const value = Reflect.get(payload, field);
  return typeof value === "string" ? value : undefined;
}

function numberField(payload: object, field: string): number | undefined {
  const value = Reflect.get(payload, field);
  return typeof value === "number" ? value : undefined;
}
