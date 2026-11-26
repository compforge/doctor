import { prepareCommandRequirements } from "../command/prepare";
import { serializeEvidence } from "../collect/serialize";
import { CommandInputError, defineCommand, type CommandInput } from "../command";
import { commandOptions, type CommandHostOption } from "../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { renderEvidence } from "../report/evidence";
import { replayPerf } from "./observations";
import { prepareLivePerf, runPerf, type PreparedLivePerf } from "./index";
import { openMetricDB, resolveMetricDBConfig } from "../datasource/metricdb";
import { resolvePerfConfig } from "./config";
import type { PerfCliOpts, PerfConfig, PerfResult } from "./model";
import { writePerfReport } from "./report";

type PerfServiceInput = CommandInput & Omit<PerfCliOpts, CommandHostOption>;
type PreparedPerf = { mode: "live"; live: PreparedLivePerf } | { mode: "replay"; from: string; config: PerfConfig };

export const perfCommand = defineCommand<PerfServiceInput, PerfResult, PreparedPerf>({
  name: "doctor perf",
  validate: input => {
    if (input.from !== undefined && !input.from.trim()) throw new CommandInputError("--from 不能为空");
  },
  serialize: async (context, result) => serializeEvidence(context, result.artifacts.filter(artifact => artifact.command === "perf")),
  render: (context, result) => renderEvidence(context, result, {
    command: "perf", title: "Perf", scope: "负载 / 时间窗口",
    render: artifact => {
      if (!result.output) throw new Error("未形成 Perf 结果");
      writePerfReport({ ...result.output, outputDir: artifact.path });
      context.write(artifact, context.read(artifact, "perf.html"));
    },
  }),
  prepare: async (context, input) => {
    const opts = { ...input, ...commandOptions(context) };
    const config = resolvePerfConfig(opts);
    if (input.from) return { mode: "replay", from: input.from, config };
    const metricdb = resolveMetricDBConfig(context.profile.value.metricdb, input.prometheus);
    if (!metricdb) {
      const { name, configPath } = context.profile;
      if (!name) throw new CommandInputError("在线 perf 需要指标源。当前未启用 profile，请指定 --prometheus <url>，或使用 --config <path> 加载已配置 metricdb.url 的 profile。");
      throw new CommandInputError([
        `在线 perf 需要指标源，profile '${name}' 缺少 metricdb.url。`,
        `请在 ${configPath || "Doctor 配置文件"} 的 profiles.${name} 下添加以下配置，并将 URL 替换为实际查询地址：`,
        "  metricdb:",
        "    kind: prometheus  # VictoriaMetrics 使用 victoriametrics",
        "    url: https://metrics.example.net",
        "也可在本次命令中指定 --prometheus <url>。",
      ].join("\n"));
    }
    const client = openMetricDB(context, metricdb);
    await prepareCommandRequirements(context, { plugin: PLUGIN_COMMAND_CAPABILITIES.perf });
    const live = await prepareLivePerf(opts, config, context.plugin, context, client);
    if (live) return { mode: "live", live };
  },
  run: (context, prepared) => prepared.mode === "replay"
    ? replayPerf(prepared.from, prepared.config, context)
    : runPerf(prepared.live, context),
});
