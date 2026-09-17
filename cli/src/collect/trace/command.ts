import { CommandInputError, defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectTrace } from "./index";
import { renderTraceReport } from "./report";
import { runOfflineTrace } from "./offline";

export type TraceInput = CommandInput & Omit<Parameters<typeof runCollectTrace>[0], CommandHostOption | "pageSize"> & { pageSize?: number };

export const traceCommand = defineCommand<TraceInput, import("./index").TraceOutput>({
  name: "doctor trace",
  render: renderTraceReport,
  environment: input => ({ kubernetes: !input.from }),
  plugin: input => input.from ? undefined : PLUGIN_COMMAND_CAPABILITIES.trace,
  validate: (input) => {
    for (const key of ["from", "node", "span"] as const) {
      if (input[key] !== undefined && !input[key]!.trim()) throw new CommandInputError(`--${key} 不能为空`);
    }
    if (input.node && !input.from) throw new CommandInputError("--node 需要 --from；在线采集请使用 --span");
    if (input.node && input.span) throw new CommandInputError("--node 与 --span 不能同时使用");
    if (input.from && input.bizIds.length) throw new CommandInputError("--from 不能与 biz-id 同时使用");
    if (!input.from && !input.bizIds.length) throw new CommandInputError("需要 biz-id 或 --from");
    if (input.from && [input.endpoint, input.host, input.index, input.indexDate, input.username,
      input.password, input.service, input.namespace].some(value => value !== undefined)) {
      throw new CommandInputError("--from 是纯离线模式，不能同时指定在线查询参数");
    }
    if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize <= 0)) {
      throw new CommandInputError("--page-size 必须为正整数");
    }
  },
  run: async (context, input) => input.from
    ? runOfflineTrace({ from: input.from, node: input.node, span: input.span }, context)
    : runCollectTrace(
      { ...input, ...commandOptions(context), pageSize: String(input.pageSize ?? 1000) }, context.plugin, context,
    ),
});
