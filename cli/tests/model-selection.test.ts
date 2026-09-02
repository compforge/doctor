import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@compforge/doctor-plugin";

import { RecentSelections } from "../src/infra/recent";
import { selectModel } from "../src/model";

const models: Model[] = [{
  id: "model-a",
  name: "Model A",
  type: "llm",
  provider: "test",
}, {
  id: "model-b",
  name: "Model B",
  type: "llm",
  provider: "test",
}];

test("交互选择的模型进入当前 profile 和租户的最近常用列表", async () => {
  const recent = new RecentSelections(
    join(mkdtempSync(join(tmpdir(), "doctor-model-recent-")), "recent.json"),
  );

  await expect(selectModel({
    models,
    profileName: "test",
    tenantId: "tenant-a",
    interactive: true,
    recent,
    prompt: async (choices) => choices[1],
  })).resolves.toEqual(models[1]);

  let offered: readonly Model[] = [];
  await selectModel({
    models,
    profileName: "test",
    tenantId: "tenant-a",
    interactive: true,
    recent,
    prompt: async (choices) => {
      offered = choices;
      return undefined;
    },
  });
  expect(offered.map((model) => model.id)).toEqual(["model-b", "model-a"]);
});

test("模型最近常用记录按 profile 和租户隔离", async () => {
  const recent = new RecentSelections(
    join(mkdtempSync(join(tmpdir(), "doctor-model-scope-")), "recent.json"),
  );
  await selectModel({
    models,
    profileName: "test",
    tenantId: "tenant-a",
    interactive: true,
    recent,
    prompt: async (choices) => choices[1],
  });

  let offered: readonly Model[] = [];
  await selectModel({
    models,
    profileName: "test",
    tenantId: "tenant-b",
    interactive: true,
    recent,
    prompt: async (choices) => {
      offered = choices;
      return undefined;
    },
  });
  expect(offered.map((model) => model.id)).toEqual(["model-a", "model-b"]);
});
