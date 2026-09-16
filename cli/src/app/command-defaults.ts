import { Option, type Command } from "commander";
import type { Distribution } from "./distribution";

/** Format choices belong to the CLI declaration, shared by parsing, Help and distribution validation. */
export function deliveryFormatOption(formats: readonly string[], flags = "-f, --format <format>"): Option {
  return new Option(flags, "输出格式；上游默认 HTML + Bundle；manifest 输出 JSON 索引，--output 指定新建证据目录（默认系统临时目录）")
    .choices([...formats, "manifest", "default"]);
}

/** @rule A distribution replaces defaults, never explicit inputs or the command's validation contract. */
export function applyCommandDefaults(program: Command, defaults: Distribution["commandDefaults"]): void {
  for (const [name, values] of Object.entries(defaults ?? {})) {
    const command = program.commands.find(candidate => candidate.name() === name);
    if (!command) throw new Error(`Distribution: unknown command '${name}'`);
    for (const [key, value] of Object.entries(values)) {
      const option = command.options.find(candidate => candidate.attributeName() === key);
      if (!option) throw new Error(`Distribution: unknown option '${name}.${key}'`);
      const boolean = !option.required && !option.optional;
      if (boolean ? typeof value !== "boolean" : typeof value === "boolean" && !option.optional) {
        throw new Error(`Distribution: invalid default for '${name}.${key}'`);
      }
      if (!boolean && Array.isArray(value) && !option.variadic && !option.parseArg) {
        throw new Error(`Distribution: '${name}.${key}' does not accept a list`);
      }
      const supplied = Array.isArray(value) ? value : [value];
      if (option.argChoices && supplied.some(item => !option.argChoices!.includes(String(item)))) {
        throw new Error(`Distribution: invalid default for '${name}.${key}'; expected ${option.argChoices.join(", ")}`);
      }
      // Commander does not parse defaults. Reuse the declared parser for numeric/repeated options.
      const parsed = option.parseArg && typeof value !== "boolean"
        ? supplied.reduce<unknown>((previous, item) => option.parseArg!(String(item), previous), undefined)
        : typeof value === "number" ? String(value) : value;
      option.default(parsed);
      command.setOptionValueWithSource(key, parsed, "default");
    }
  }
}
