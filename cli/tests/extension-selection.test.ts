import { withSummary } from "@compforge/doctor-plugin";
import { expect, mock, test } from "bun:test";
import { createServiceCatalog, type ServiceDefinition } from "@compforge/doctor-plugin";
import { selectExtension } from "../src/plugin/select-extension";
import { discoverTenantDirectory } from "../src/plugin/tenant-directory";
import { createHostPluginContext } from "../src/plugin/context";
import { withInteractionOptions } from "../src/terminal/policy";

const service = (name: string): ServiceDefinition => ({
  name, aliases: [name + "-alias"], workloads: [],
  component: { name, repository: { forge: { name: "test" }, path: name } },
});

test("provider selection preserves Service and Extension identity without executing candidates", async () => {
  const run = mock(async () => []);
  const first = { id: "first", kind: "tenant.list", access: {}, endpoint: { host: "one", port: 80 }, run: withSummary({title:"Tenant",fields:[]}, run) };
  const second = { ...first, id: "second" };
  const one = { ...service("one"), extensions: [first, second] };
  const two = { ...service("two"), extensions: [first] };
  const catalog = createServiceCatalog([one, two]);
  await withInteractionOptions({ yes: true }, async () => {
    await expect(selectExtension(catalog, "missing")).rejects.toThrow("No missing");
    await expect(selectExtension(catalog, "tenant.list")).rejects.toThrow("Ambiguous");
    await expect(selectExtension(catalog, "tenant.list", { service: "one" })).rejects.toThrow("Ambiguous");
    expect(await selectExtension(catalog, "tenant.list", { service: "one-alias/second" }))
      .toEqual({ service: one, extension: second });
    expect(await selectExtension(catalog, "tenant.list", { service: "two" }))
      .toEqual({ service: two, extension: first });
    await expect(selectExtension(catalog, "tenant.list", { service: "unknown" })).rejects.toThrow("No tenant.list");
  });
  expect(run).not.toHaveBeenCalled();
});

test("directory opens only the selected operation and never invents user search", async () => {
  const selected = mock(async () => [{ id: "t", name: "tenant", displayName: "Tenant" }]);
  const unused = mock(async () => { throw new Error("must not execute"); });
  const catalog = createServiceCatalog([{
    ...service("directory"), extensions: [
      { id: "a", kind: "tenant.list", endpoint: { host: "directory", port: 80 }, access: {}, run: withSummary({"title":"租户列表","fields":[{"label":"租户数","path":["length"]}]}, unused) } satisfies import("@compforge/doctor-plugin").TenantListExtension,
      { id: "b", kind: "tenant.list", endpoint: { host: "directory", port: 80 }, access: {}, run: withSummary({"title":"租户列表","fields":[{"label":"租户数","path":["length"]}]}, selected) } satisfies import("@compforge/doctor-plugin").TenantListExtension,
      { id: "resolve", kind: "tenant.resolve", endpoint: { host: "directory", port: 80 }, access: {}, run: withSummary({"title":"租户详情","fields":[{"label":"ID","path":["id"]},{"label":"名称","path":["name"]},{"label":"显示名称","path":["displayName"]}]}, unused) } satisfies import("@compforge/doctor-plugin").TenantResolveExtension,
    ],
  }]);
  const opened: string[] = [];
  const directory = discoverTenantDirectory(catalog, (service, extension) => {
    opened.push(extension.id);
    return Promise.resolve(createHostPluginContext({ service, capability: extension }));
  }, { service: "directory/b" });
  expect(directory.searchActiveUsers).toBeUndefined();
  expect(opened).toEqual([]);
  expect(await directory.listActive()).toHaveLength(1);
  expect(opened).toEqual(["b"]);
  expect(unused).not.toHaveBeenCalled();
});
