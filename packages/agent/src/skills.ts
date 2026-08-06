import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { Skill } from "./types";

export function formatSkillCatalog(skills: readonly Skill[]): string {
  if (!skills.length) return "";
  const lines = [
    "The following Plugin Skills provide specialized diagnostic instructions.",
    "When a task matches a description, call read_skill before following the Skill.",
    "Use read_skill_resource for references named by the Skill.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function createSkillTools(skills: readonly Skill[]): AgentTool[] {
  if (!skills.length) return [];
  const byName = new Map<string, Skill>();
  for (const skill of skills) {
    if (byName.has(skill.name)) throw new Error(`duplicate Plugin Skill name: ${skill.name}`);
    byName.set(skill.name, skill);
  }

  const readSkillParameters = Type.Object({ name: Type.String() });
  const readSkill: AgentTool<typeof readSkillParameters> = {
    name: "read_skill",
    label: "Read Skill",
    description: "Load the complete instructions for an available Plugin Skill.",
    parameters: readSkillParameters,
    execute: async (_id, params) => {
      const skill = byName.get(params.name);
      if (!skill) throw new Error(`unknown Plugin Skill: ${params.name}`);
      return {
        content: [{
          type: "text",
          text: `<skill name="${skill.name}" location="${skill.filePath}">\n${skill.content}\n</skill>`,
        }],
        details: { skill: skill.name },
      };
    },
  };

  const readResourceParameters = Type.Object({ name: Type.String(), path: Type.String() });
  const readResource: AgentTool<typeof readResourceParameters> = {
    name: "read_skill_resource",
    label: "Read Skill Resource",
    description: "Read a relative reference file owned by an available Plugin Skill.",
    parameters: readResourceParameters,
    execute: async (_id, params, signal) => {
      const skill = byName.get(params.name);
      if (!skill) throw new Error(`unknown Plugin Skill: ${params.name}`);
      if (!skill.readResource) throw new Error(`Plugin Skill ${params.name} does not expose resources`);
      if (params.path.startsWith("/") || params.path.split(/[\\/]/).includes("..")) {
        throw new Error(`Skill resource path must stay relative to ${params.name}: ${params.path}`);
      }
      const content = await skill.readResource(params.path, signal);
      return {
        content: [{ type: "text", text: content }],
        details: { skill: skill.name, path: params.path },
      };
    },
  };

  return [readSkill, readResource];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
