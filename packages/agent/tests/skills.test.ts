import { describe, expect, test } from "bun:test";

import { createSkillTools, formatSkillCatalog, type Skill } from "../src";

const skill: Skill = {
  name: "sample-ops",
  description: "Diagnose sample services.",
  content: "Follow the evidence.",
  filePath: "/plugins/sample/skills/sample-ops/SKILL.md",
  readResource: async (path) => `resource:${path}`,
};

describe("Plugin Skills", () => {
  test("lists metadata without eagerly injecting instructions", () => {
    const prompt = formatSkillCatalog([skill]);

    expect(prompt).toContain("<name>sample-ops</name>");
    expect(prompt).not.toContain("Follow the evidence.");
  });

  test("loads instructions and relative resources through agent tools", async () => {
    const [readSkill, readResource] = createSkillTools([skill]);

    const instructions = await readSkill!.execute("call-1", { name: "sample-ops" });
    const resource = await readResource!.execute("call-2", {
      name: "sample-ops",
      path: "references/guide.md",
    });

    expect(instructions.content[0]).toMatchObject({ text: expect.stringContaining("Follow the evidence.") });
    expect(resource.content[0]).toEqual({ type: "text", text: "resource:references/guide.md" });
  });

  test("rejects resource traversal before calling the Plugin", async () => {
    const [, readResource] = createSkillTools([skill]);

    await expect(readResource!.execute("call-3", {
      name: "sample-ops",
      path: "../secret",
    })).rejects.toThrow("must stay relative");
  });
});
