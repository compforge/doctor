import { prepareCommandRequirements } from "../../command/prepare";
import { serializeEvidenceResult } from "../serialize";
import { CommandInputError, defineCommand, type CommandInput } from "../../command";
import { defaultCommandReportName } from "../../command/report-name";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectTrace } from "./index";
import { renderTraceReport } from "./report";
import { runOfflineTrace } from "./offline";
import { runFileTrace } from "./file";
import { resolveTraceWindow } from "./window";

export type TraceInput = CommandInput & Omit<Parameters<typeof runCollectTrace>[0], CommandHostOption | "pageSize"> & { pageSize?: number };

export const traceCommand = defineCommand<TraceInput, import("./index").TraceOutput>({
  serialize: serializeEvidenceResult,
  name: "doctor trace",
  render: renderTraceReport,
  // Offline evidence supplies the trace ID; failed preparation can still use the invocation ID.
  reportName: (input, result, now) => defaultCommandReportName("trace",
    input.from || input.traceFile || input.since || input.sinceTime
      ? result.output?.items[0]?.traceIds ?? [] : input.bizIds, now),
  validate: (input) => {
    for (const key of ["from", "traceFile", "node", "span"] as const) {
      if (input[key] !== undefined && !input[key]!.trim()) {
        throw new CommandInputError(`--${key === "traceFile" ? "trace-file" : key} 不能为空`);
      }
    }
    if (input.node && !input.from) throw new CommandInputError("--node 需要 --from；在线采集请使用 --span");
    if (input.node && input.span) throw new CommandInputError("--node 与 --span 不能同时使用");
    const range = input.since !== undefined || input.sinceTime !== undefined || input.untilTime !== undefined;
    const modes = Number(Boolean(input.from)) + Number(Boolean(input.traceFile)) + Number(Boolean(input.bizIds.length))
      + Number(range);
    if (modes !== 1) throw new CommandInputError("需且只需指定一种输入：biz-id、时间范围、--trace-file 或 --from");
    if (range) {
      try { resolveTraceWindow(input); }
      catch (error) { throw new CommandInputError(error instanceof Error ? error.message : String(error)); }
    }
    for (const [name, value] of [["limit", input.limit], ["concurrency", input.concurrency]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
        throw new CommandInputError(`--${name} 必须为正整数`);
      }
    }
    if (input.limit !== undefined && !range) throw new CommandInputError("--limit 仅用于时间范围采集");
    if ((input.from || input.traceFile) && input.concurrency !== undefined) throw new CommandInputError("本地输入不能与 --concurrency 同时使用");
    if (input.traceFile && input.span) throw new CommandInputError("--trace-file 不能与 --span 同时使用；导入后用 --from 下钻");
    // Global Kubernetes scope may come from Distribution defaults; offline reads never use it.
    if ((input.from || input.traceFile) && [input.endpoint, input.host, input.index, input.indexDate, input.username,
      input.password, input.service].some(value => value !== undefined)) {
      throw new CommandInputError("本地输入是纯离线模式，不能同时指定在线查询参数");
    }
    if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize <= 0)) {
      throw new CommandInputError("--page-size 必须为正整数");
    }
  },
  prepare: async (context, input) => {
    await prepareCommandRequirements(context, {
      plugin: input.from || input.traceFile ? undefined
        : input.since || input.sinceTime ? PLUGIN_COMMAND_CAPABILITIES.traceRange : PLUGIN_COMMAND_CAPABILITIES.trace,
      environment: { kubernetes: !input.from && !input.traceFile },
    });
    return input;
  },
  run: async (context, input) => input.from
    ? runOfflineTrace({ from: input.from, node: input.node, span: input.span }, context)
    : input.traceFile ? runFileTrace(input.traceFile, context)
    : runCollectTrace(
      { ...input, ...commandOptions(context), pageSize: String(input.pageSize ?? 1000) },
      await context.resolvePlugin(), context,
    ),
});
