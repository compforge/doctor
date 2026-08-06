import { expect, test } from "bun:test";

import {
  createServiceCatalog,
  type PluginDefinition,
  type PluginSkill,
} from "../src";

test("PluginDefinition carries resolved Skills from the same Plugin version", async () => {
  const skill: PluginSkill = {
    name: "sample-ops",
    description: "Diagnose sample services.",
    content: "Follow the evidence.",
    filePath: "plugin://sample/skills/sample-ops/SKILL.md",
    readResource: async (path) => `resource:${path}`,
  };
  const plugin = {
    id: "sample",
    services: createServiceCatalog([]),
    skills: [skill],
  } satisfies PluginDefinition;

  expect(plugin.skills[0]).toBe(skill);
  expect(await plugin.skills[0]!.readResource?.("references/guide.md"))
    .toBe("resource:references/guide.md");
});
