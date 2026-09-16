import type { Command } from "commander";

declare const __DOCTOR_COMMANDS__: string | undefined;

// @spec 构建时固定 help 的命令可见性；运行时环境变量不能改变它。源码运行默认全部可见。
export const DOCTOR_COMMANDS = typeof __DOCTOR_COMMANDS__ === "undefined" ? "all" : __DOCTOR_COMMANDS__;

/** Select visible top-level commands; hidden commands remain callable via Commander. */
export function selectVisibleCommands(catalog: readonly Command[], selection: string): Command[] {
  const value = selection.trim();
  if (value === "all") return [...catalog];

  const names = value.split(",").map(name => name.trim());
  const available = new Set(catalog.map(command => command.name()));
  for (const name of names) {
    if (!available.has(name)) {
      throw new Error(`Invalid DOCTOR_COMMANDS entry '${name}'; expected all or comma-separated command names: ${[...available].join(",")}`);
    }
  }

  // 帮助和版本用于识别发行物，始终可见。
  const selected = new Set(["help", "version", ...names]);
  return catalog.filter(command => selected.has(command.name()));
}
