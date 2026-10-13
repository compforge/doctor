import type { View } from "@compforge/trace-harness";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult } from "../../command/result";
import type { SerializeContext } from "../../command/serialization/context";
import type { CollectionRecord } from "../output/report/model";
import type { TraceOutput } from "./index";
import { readTraceSnapshot, selectTraceView, writeTraceJson, type TraceViewOptions } from "./snapshot";

/** Selection is a separate local processing step shared by online acquisition and --from. */
export async function prepareTraceViews(result: CommandResult<TraceOutput>, options: TraceViewOptions): Promise<void> {
  const { render } = await import("@compforge/trace-harness");
  for (const item of result.output?.items ?? []) for (const artifact of item.artifacts) {
    const dir = artifact.path;
    if (!existsSync(join(dir, "analysis.json"))) continue;
    const view = await selectTraceView(dir, options);
    writeTraceJson(dir, "view.json", view);
    const snapshot = readTraceSnapshot(dir);
    const collection = JSON.parse(readFileSync(join(dir, "collection.json"), "utf8")) as CollectionRecord;
    const header = `Trace ${snapshot.trace_id} · status=${item.status} · scope=${snapshot.collection.scope} · complete=${snapshot.collection.complete}`;
    writeFileSync(join(dir, "view.txt"), `${header}\n${item.reason ?? ""}\n${render(view, { format: "text" })}`, { mode: 0o600 });
    writeTraceJson(dir, "collection.json", { ...collection, files: { ...collection.files, view: "view.json", text: "view.txt" } });
  }
}

/** The root export keeps acquisition status alongside the selected views, including failed batch items. */
export function serializeTraceViews(context: SerializeContext, result: CommandResult<TraceOutput>) {
  const texts = [`doctor trace · status=${result.status}`];
  if (result.output?.selection?.truncated) texts.push(`selection truncated: ${result.output.selection.truncated.reason}`);
  const items = (result.output?.items ?? []).map(item => {
    texts.push(`input=${item.bizId} · status=${item.status}${item.reason ? ` · ${item.reason}` : ""}`);
    const traces = item.artifacts.flatMap(artifact => {
      const dir = artifact.path;
      if (!existsSync(join(dir, "view.json"))) return [];
      const view = JSON.parse(readFileSync(join(dir, "view.json"), "utf8")) as View;
      const snapshot = readTraceSnapshot(dir);
      texts.push(readFileSync(join(dir, "view.txt"), "utf8"));
      const collection = JSON.parse(readFileSync(join(dir, "collection.json"), "utf8")) as CollectionRecord;
      const selection = collection.target?.selected_span_id
        ? JSON.parse(readFileSync(join(dir, "selection.json"), "utf8")) : undefined;
      if (selection) texts.push(`Selected span evidence:\n${JSON.stringify(selection, null, 2)}`);
      return [{ trace_id: view.trace_id, collection: snapshot.collection, view, selection }];
    });
    return { input_id: item.bizId, trace_ids: item.traceIds, status: item.status, reason: item.reason, traces };
  });
  if ("reason" in result && result.reason) texts.push(result.reason);
  return {
    output: context.writeJson("views.json", { schema_version: 1, kind: "doctor.trace.views", status: result.status,
      reason: "reason" in result ? result.reason : undefined, selection: result.output?.selection, items }),
    text: context.writeText("views.txt", `${texts.join("\n\n")}\n`),
  };
}
