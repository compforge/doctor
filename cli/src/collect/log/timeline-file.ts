import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import type { LogTimelineRecord } from "./model";

/** @spec Only a fully written artifact is published under its final name. */
async function writeLines(path: string, lines: AsyncIterable<string> | Iterable<string>): Promise<void> {
  const part = `${path}.${randomUUID()}.part`;
  async function* chunks() {
    let buffer = "";
    for await (const line of lines) {
      buffer += line + "\n";
      if (buffer.length >= 65536) { yield buffer; buffer = ""; }
    }
    if (buffer) yield buffer;
  }
  try {
    await pipeline(chunks(), createWriteStream(part, { mode: 0o600 }));
    await rename(part, path);
  } finally {
    await rm(part, { force: true });
  }
}

export function writeTimeline(dir: string, records: readonly LogTimelineRecord[]): Promise<void> {
  function* lines() { for (const record of records) yield JSON.stringify(record); }
  return writeLines(join(dir, "timeline.jsonl"), lines());
}

export async function* readTimeline(dir: string): AsyncGenerator<LogTimelineRecord> {
  const input = createReadStream(join(dir, "timeline.jsonl"), { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as LogTimelineRecord;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

export function writeServiceLogs(dir: string, keys: readonly string[], namespace: string, services: readonly string[]): Promise<void> {
  async function* lines() {
    yield `keys=${keys.join(",")}`;
    yield `namespace=${namespace}`;
    yield `services=${services.join(",")}`;
    yield "";
    let errors = false;
    let logs = false;
    // buildLogTimeline puts collection errors before the chronologically ordered log events.
    for await (const entry of readTimeline(dir)) {
      if (entry.kind === "collection_error") {
        if (!errors) yield "===== collection errors =====";
        errors = true;
        yield `[service/${entry.service} pod/${entry.pod}] ${entry.message}`;
        continue;
      }
      if (!logs) {
        if (errors) yield "";
        yield "===== timeline =====";
        logs = true;
      }
      const container = entry.container ? ` container/${entry.container}` : "";
      const previous = entry.instance === "previous" ? " instance/previous" : "";
      const timestamp = entry.timestamp ? `${entry.timestamp} ` : "";
      const matches = entry.matches?.map(match => `${match.kind}:${match.identity.kind}=${match.identity.value}`).join(", ");
      yield `[service/${entry.service} pod/${entry.pod}${container}${previous}] ${timestamp}${matches ? "[" + matches + "] " : ""}${entry.message}`;
    }
    if (!logs) {
      if (errors) yield "";
      yield "===== timeline =====";
      yield "(no matched log lines)";
    }
  }
  return writeLines(join(dir, "service-logs.txt"), lines());
}
