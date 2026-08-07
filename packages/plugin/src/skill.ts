/** A resolved Skill owned and versioned by one Plugin. */
export interface PluginSkill {
  name: string;
  description: string;
  content: string;
  /** Absolute path to SKILL.md, readable from the host's Pi ExecutionEnv. */
  filePath: string;
}

/** Stable target facts a host exposes while a Plugin prepares Skill script access. */
export interface SkillExecutionTarget {
  env: string;
  namespace?: string;
  readonly: boolean;
}

/**
 * Additional host-neutral inputs for Skill scripts.
 *
 * Environment keys should use the TARGET_* contract. Secrets belong in env only and must not be
 * repeated in contextPrompt, which is visible to the model.
 */
export interface PreparedSkillContext {
  env?: Readonly<Record<string, string>>;
  contextPrompt?: string;
}
