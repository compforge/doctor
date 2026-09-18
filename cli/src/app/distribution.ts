import type { PluginDefinition } from "@compforge/doctor-plugin";

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
  /** If omitted, commands use the existing Host Plugin loader when needed. */
  plugin?: PluginDefinition;
}
