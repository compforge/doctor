import { isInteractive } from "../../terminal/policy";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import { CommandStatus, aggregateCommandStatus, commandOutcome, type CommandResult } from "../../command";

import { useLogger } from "../../terminal/log";
import { REDIS_DEFAULTS, runCollectRedis } from "../redis";
import {
  parseStoreOutputFormat,
  resolveStoreConfig,
  resolveStoreKinds,
  type CollectStoreCliOpts,
} from "./config";
import { runStoreDb } from "./db";
import { runStoreS3 } from "./s3";
import { runStoreVdb } from "./vdb";

export async function runCollectStore(
  opts: CollectStoreCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<CommandResult<void>> {
  const interactive = isInteractive();
  let kinds;
  try {
    kinds = await resolveStoreKinds(opts.type, plugin, interactive);
  } catch (error) {
    useLogger("collect").error(`${error instanceof Error ? error.message : String(error)}`);
    return commandOutcome(2);
  }
  if (!kinds) return commandOutcome(130);
  try {
    parseStoreOutputFormat(opts.format);
  } catch (error) {
    useLogger("collect").error(`${error instanceof Error ? error.message : String(error)}`);
    return commandOutcome(2);
  }
  const statuses: CommandStatus[] = [];
  let failure: CommandResult<void> | undefined;
  for (const kind of kinds) {
    if (commandContext.signal.aborted) { statuses.push(CommandStatus.Cancelled); break; }
    let result: CommandResult<void>;
    const kindOpts = kinds.length > 1
      ? { ...opts, output: undefined, deferDelivery: true }
      : opts;
    if (kind === "redis") {
      result = await runCollectRedis({
        ...kindOpts,
        maxKeys: kindOpts.maxKeys ?? String(REDIS_DEFAULTS.maxKeys),
        maxKeysPerSecond: kindOpts.maxKeysPerSecond ?? String(REDIS_DEFAULTS.maxKeysPerSecond),
        top: kindOpts.top ?? String(REDIS_DEFAULTS.top),
      }, commandContext, undefined, undefined, plugin.services);
    } else {
      let resolved;
      try {
        resolved = await resolveStoreConfig({ ...kindOpts, type: kind }, plugin, commandContext);
      } catch (error) {
        useLogger("collect").error(`${error instanceof Error ? error.message : String(error)}`);
        failure ??= commandOutcome(2);
        statuses.push(CommandStatus.Failed);
        continue;
      }
      if (!resolved) {
        return commandOutcome(130);
      }
      const { config, executor } = resolved;
      if (config.capability.kind !== "vdb" && !config.target && !config.capability.source) {
        throw new Error(`Store capability '${config.service}/${config.capability.id}' 未提供配置来源 Pod`);
      }
      if (config.capability.kind === "db") result = await runStoreDb(config, commandContext, executor);
      else if (config.capability.kind === "vdb") result = await runStoreVdb(config, commandContext, executor);
      else result = await runStoreS3(config, commandContext, executor);
    }
    if (result.status === CommandStatus.Cancelled) {
      return result;
    }
    if (result.status === CommandStatus.Failed) failure ??= result;
    statuses.push(result.status);
  }
  const status = aggregateCommandStatus(statuses);
  if (status === CommandStatus.Failed && failure) return failure;
  return { status, output: undefined, artifacts: commandContext.artifacts.list() };
}

export * from "./config";
export * from "./db";
export * from "./s3";
export * from "./s3-inventory";
export * from "./vdb";
