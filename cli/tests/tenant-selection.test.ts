import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantDirectory, TenantSummary } from "@compforge/doctor-plugin";

import { RecentSelections } from "../src/infra/recent";
import { resolveModelTenant } from "../src/model";
import { CommandContext } from "../src/command";

test("交互选择的租户进入当前 profile 的最近常用列表", async () => {
  const tenants: TenantSummary[] = [{
    id: "tenant-a",
    name: "tenant-a",
    displayName: "Tenant A",
  }, {
    id: "tenant-b",
    name: "tenant-b",
    displayName: "Tenant B",
  }];
  const directory: TenantDirectory = {
    listActive: async () => tenants,
    getByName: async (name) => tenants.find((tenant) => tenant.name === name)!,
  };
  const recent = new RecentSelections(
    join(mkdtempSync(join(tmpdir(), "doctor-tenant-recent-")), "recent.json"),
  );

  await expect(resolveModelTenant({
    profileName: "test",
    directory,
    interactive: true,
    recent,
    prompt: async (choices) => choices[1],
  })).resolves.toEqual(tenants[1]);
  expect(recent.recentChoices(
    "tenant",
    "test",
    tenants,
    (tenant) => tenant.id,
  )).toEqual([tenants[1]]);
});

test("standalone 与 composite collector 通过 CommandContext 复用同一租户决策", async () => {
  const tenant = { id: "tenant-a", name: "tenant-a", displayName: "Tenant A" };
  let prompts = 0;
  const commandContext = new CommandContext({});
  const input = {
    profileName: "test",
    directory: {
      listActive: async () => [tenant],
      getByName: async () => tenant,
    },
    commandContext,
    interactive: true,
    prompt: async () => {
      prompts += 1;
      return tenant;
    },
  };

  await expect(resolveModelTenant(input)).resolves.toEqual(tenant);
  await expect(resolveModelTenant(input)).resolves.toEqual(tenant);
  expect(prompts).toBe(1);
});
