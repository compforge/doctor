import type { PluginDefinition } from "@compforge/doctor-plugin";

/**
 * A distribution composes CLI presentation and an optional trusted Plugin, not business behavior.
 * @spec Distributions share Doctor execution and Plugin contracts. Command selection only hides Help entries.
 */
export interface Distribution {
  name?: string;
  description?: string;
  /** Visible top-level commands, comma-separated; defaults to the build's DOCTOR_COMMANDS. */
  commands?: string;
  /** If omitted, commands use the existing Host Plugin loader when needed. */
  plugin?: PluginDefinition;
}
