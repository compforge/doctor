/** A resolved Skill owned and versioned by one Plugin. */
export interface PluginSkill {
  name: string;
  description: string;
  content: string;
  /** Absolute path to SKILL.md, readable from the host's Pi ExecutionEnv. */
  filePath: string;
}
