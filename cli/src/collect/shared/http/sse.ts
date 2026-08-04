export interface ParsedSseEvent {
  index: number;
  event?: string;
  id?: string;
  retry?: string;
  data: string;
  comments: readonly string[];
  raw: string;
  bytes: number;
}

export interface ParsedSseCapture {
  events: readonly ParsedSseEvent[];
  trailingRaw?: string;
  trailingBytes: number;
}

function parseEvent(raw: string, index: number): ParsedSseEvent {
  const data: string[] = [];
  const comments: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: string | undefined;
  const content = raw.replace(/(?:\r\n\r\n|\n\n|\r\r)$/, "");

  for (const line of content.split(/\r\n|\n|\r/)) {
    if (line.startsWith(":")) {
      comments.push(line.slice(1).replace(/^ /, ""));
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "retry") retry = value;
  }

  return {
    index,
    event,
    id,
    retry,
    data: data.join("\n"),
    comments,
    raw,
    bytes: Buffer.byteLength(raw),
  };
}

/**
 * SSE 只有遇到空行才完成一次事件分派。末尾没有分隔符的内容单独保留，
 * 避免把抓包截断的半个事件伪装成完整消息。
 */
export function parseSseCapture(text: string): ParsedSseCapture {
  const events: ParsedSseEvent[] = [];
  const delimiter = /\r\n\r\n|\n\n|\r\r/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = delimiter.exec(text)) !== null) {
    const raw = text.slice(cursor, delimiter.lastIndex);
    const content = text.slice(cursor, match.index);
    if (content.length > 0) events.push(parseEvent(raw, events.length + 1));
    cursor = delimiter.lastIndex;
  }

  const trailingRaw = text.slice(cursor);
  return {
    events,
    trailingRaw: trailingRaw.length > 0 ? trailingRaw : undefined,
    trailingBytes: Buffer.byteLength(trailingRaw),
  };
}
