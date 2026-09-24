import type { LogLevel } from "../terminal/log";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePluginRef } from "../plugin/manifest";

/**
 * A distribution composes CLI presentation and an optional trusted Plugin, not business behavior.
 * @spec Distributions share Doctor execution and Plugin contracts. Command selection only hides Help entries.
 */
export interface Distribution {
  name?: string;
  /** User-facing release version; defaults to the embedded Doctor Core version. */
  version?: string;
  description?: string;
  /** Visible top-level commands, comma-separated; defaults to the build's DOCTOR_COMMANDS. */
  commands?: string;
  /** Defaults for declared root options; config: "" disables external profile configuration. */
  optionDefaults?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  /** Defaults for declared command options (camelCase keys); explicit CLI/environment values win. */
  commandDefaults?: Readonly<Record<string, Readonly<Record<string, string | number | boolean | readonly string[]>>>>;
  /** Minimum execution log level; "error" retains errors only. Results and prompts are independent. */
  logLevel?: LogLevel;
  /** If omitted, commands use the existing Host Plugin loader when needed. */
  plugin?: PluginDefinition;
}

/** JSON form of a Distribution. Executable Plugin code remains owned by the Host loader. */
export type DistributionManifest = Omit<Distribution, "plugin"> & {
  plugin?: string;
};

/** Chat execution belongs to the Host, not to the CLI presentation. */
export interface DoctorHostOptions {
  agentCommands?: Readonly<Record<string, DistributionManifest>>;
}

const logLevels = new Set(["error", "warn", "info", "verbose"]);
const fields = new Set(["name", "version", "description", "commands", "optionDefaults", "commandDefaults", "logLevel", "plugin"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Distribution: ${label} must be an object`);
  return value as Record<string, unknown>;
}

function defaults(value: unknown, label: string): Distribution["optionDefaults"] {
  const entries = record(value, label);
  for (const [key, item] of Object.entries(entries)) {
    if (typeof item === "string" || typeof item === "number" && Number.isFinite(item) || typeof item === "boolean") continue;
    if (Array.isArray(item) && item.every(value => typeof value === "string")) continue;
    throw new Error(`Distribution: ${label}.${key} has an invalid default`);
  }
  return entries as Distribution["optionDefaults"];
}

export function parseDistributionManifest(value: unknown): DistributionManifest {
  const input = record(value, "JSON root");
  for (const key of Object.keys(input)) {
    if (!fields.has(key)) throw new Error(`Distribution: unknown field '${key}'`);
  }
  for (const key of ["name", "version", "description", "commands", "plugin"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key])) {
      throw new Error(`Distribution: ${key} must be a non-empty string`);
    }
  }
  if (input.plugin !== undefined) parsePluginRef(input.plugin as string);
  if (input.logLevel !== undefined && !logLevels.has(input.logLevel as string)) {
    throw new Error("Distribution: invalid logLevel");
  }
  if (input.optionDefaults !== undefined) defaults(input.optionDefaults, "optionDefaults");
  if (input.commandDefaults !== undefined) {
    for (const [command, value] of Object.entries(record(input.commandDefaults, "commandDefaults"))) {
      defaults(value, `commandDefaults.${command}`);
    }
  }
  return input as DistributionManifest;
}

export function loadDistributionManifest(path: string): DistributionManifest {
  const file = resolve(path);
  try {
    return parseDistributionManifest(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`Distribution ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Extract before Commander builds the command surface and its defaults. */
export function extractDistributionArgument(argv: readonly string[]): { path?: string; argv: string[] } {
  const args = [...argv];
  let path: string | undefined;
  for (let index = 2; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--") break;
    if (argument !== "--distribution" && !argument.startsWith("--distribution=")) continue;
    if (path !== undefined) throw new Error("--distribution may be specified only once");
    path = argument === "--distribution" ? args[index + 1] : argument.slice("--distribution=".length);
    if (!path || path.startsWith("--")) throw new Error("--distribution requires a JSON file path");
    args.splice(index, argument === "--distribution" ? 2 : 1);
    index--;
  }
  return { path, argv: args };
}
