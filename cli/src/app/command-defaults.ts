import { Help, Option, type Command } from "commander";
import type { Distribution } from "./distribution";

/** Format choices belong to the CLI declaration, shared by parsing, Help and distribution validation. */
export function deliveryFormatOption(formats: readonly string[], flags = "-f, --format <format>"): Option {
  return new Option(flags, "输出格式")
    .choices([...formats, "manifest", "default"]);
}

const formatExamples: Readonly<Record<string, string>> = {
  default: "-f default -o ./report → ./report.html 与 ./report.tar.gz（两个文件）",
  html: "-f html -o ./report.html → HTML 文件",
  json: "-f json -o ./report.json → JSON 文件",
  md: "-f md -o ./report.md → Markdown 文件",
  bundle: "-f bundle -o ./report.tar.gz → 归档文件",
  manifest: "-f manifest -o ./evidence → ./evidence/manifest.json（证据目录）",
  summary: "-f summary → 终端摘要；证据保存在临时目录，无需 -o",
};

const formatDefaults: Readonly<Record<string, string>> = {
  default: "HTML + Bundle",
  html: "HTML 文件",
  json: "JSON 文件",
  md: "Markdown 文件",
  bundle: "归档文件",
  manifest: "JSON 索引与临时证据目录",
  summary: "终端摘要与临时证据目录",
};

/** Help reads the effective Distribution defaults after command registration. */
export function configureDeliveryHelp(program: Command): void {
  for (const command of program.commands) {
    const format = command.options.find(option => option.attributeName() === "format" && option.argChoices?.includes("manifest"));
    const output = command.options.find(option => option.attributeName() === "output");
    if (!format || !output) continue;
    const formats = format.argChoices ?? [];
    const defaultFormat = String(format.defaultValue ?? "default");
    const examples = ["default", "html", "bundle", "json", "md", "manifest", "summary"]
      .filter(choice => formats.includes(choice))
      .map(choice => `  ${formatExamples[choice]}`)
      .join("\n");
    const previous = command.configureHelp().optionDescription;
    command.configureHelp({
      ...command.configureHelp(),
      optionDescription(option) {
        if (option === format) return `${previous?.call(this, option) ?? Help.prototype.optionDescription.call(this, option)}；当前默认 ${defaultFormat}（${formatDefaults[defaultFormat] ?? defaultFormat}）`;
        if (option === output) return "按格式指定文件或证据目录；见下方输出路径示例";
        return previous?.call(this, option) ?? Help.prototype.optionDescription.call(this, option);
      },
    });
    command.addHelpText("after", `\n输出路径示例：\n${examples}\n`);
  }
}

/** @rule A distribution replaces defaults, never explicit inputs or the command's validation contract. */
export function applyCommandDefaults(program: Command, defaults: Distribution["commandDefaults"]): void {
  for (const [name, values] of Object.entries(defaults ?? {})) {
    const command = program.commands.find(candidate => candidate.name() === name);
    if (!command) throw new Error(`Distribution: unknown command '${name}'`);
    applyOptionDefaults(command, values, name);
  }
}

export function applyOptionDefaults(command: Command, defaults: Distribution["optionDefaults"], name = "root"): void {
  for (const [key, value] of Object.entries(defaults ?? {})) {
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
