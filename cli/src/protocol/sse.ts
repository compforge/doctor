import type { AgentEventBase } from "./types";

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<AgentEventBase> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  // signal 触发时主动 cancel reader——fetch 自己也会被 abort 取消，但 reader 不会自动收尾，
  // 不 cancel 会导致 await reader.read() 永远不返回。
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE 帧分隔可能是 \n\n（LF LF）或 \r\n\r\n（CRLF CRLF）——sse-starlette 默认 CRLF；都得支持
      const boundary = /\r?\n\r?\n/;
      let m: RegExpExecArray | null;
      while ((m = boundary.exec(buf)) !== null) {
        const frame = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = parseFrame(frame);
        if (ev) yield ev;
      }
    }

    // Flush trailing data (in case server didn't end with frame boundary).
    if (!signal?.aborted) {
      buf += decoder.decode();
      if (buf.trim()) {
        const ev = parseFrame(buf);
        if (ev) yield ev;
      }
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function parseFrame(frame: string): AgentEventBase | null {
  let dataLine: string | null = null;
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      const rest = line.slice(5).trimStart();
      dataLine = dataLine === null ? rest : dataLine + "\n" + rest;
    }
    // event:/id:/retry: lines are accepted but the JSON in data: is canonical.
  }
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine) as AgentEventBase;
  } catch {
    // Malformed JSON — skip silently per spec (CLI must not crash).
    return null;
  }
}
