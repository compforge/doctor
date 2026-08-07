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
    filePath: "/plugins/sample/skills/sample-ops/SKILL.md",
  };
  const plugin = {
    id: "sample",
    version: "0.0.1",
    services: createServiceCatalog([]),
    skills: [skill],
  } satisfies PluginDefinition;

  expect(plugin.skills[0]).toBe(skill);
});
