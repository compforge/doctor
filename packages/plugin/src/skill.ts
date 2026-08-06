/** A resolved Skill owned and versioned by one Plugin. */
export interface PluginSkill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  readResource?(relativePath: string, signal?: AbortSignal): Promise<string>;
}
