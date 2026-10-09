import { expect, test } from "bun:test";
import { createServiceCatalog, kubernetesServiceWorkload, withSummary,
  type CaseProduceExtension, type ServiceRequestIdentity, type TenantDirectory } from "@compforge/doctor-plugin";
import { CommandContext } from "../src/command";
import { resolveHealthCaseIdentity } from "../src/health/identity";
import { prepareServiceCases } from "../src/health/case-prepare";
import { checkServiceCases } from "../src/health/cases";
import { resolveTenant } from "../src/terminal/tenant";
import { withInteractionOptions } from "../src/terminal/policy";

const tenant = { id: "tenant-a", name: "alpha", displayName: "Alpha" };
const user = { id: "user-a", name: "alice", displayName: "Alice" };
const producer: CaseProduceExtension = {
  id: "hello", kind: "case.produce", access: {},
  requestIdentity: { configured: () => ({}) },
  run: withSummary({ title: "Hello", fields: [] }, async () => ({ cases: [], reason: "fixture" })),
};
const unavailableDirectory: TenantDirectory = {
  listActive: async () => { throw new Error("unexpected tenant lookup"); },
  getByName: async () => { throw new Error("unexpected tenant lookup"); },
};

test("Health fills one identity for multiple producers, with tenant-scoped user search", async () => {
  const context = new CommandContext({});
  let tenants = 0, users = 0;
  const directory: TenantDirectory = {
    ...unavailableDirectory,
    listActive: async () => { tenants++; return [tenant]; },
    searchActiveUsers: async input => {
      expect(input.tenantId).toBe(tenant.id);
      users++;
      return { users: [user], total: 1 };
    },
  };
  const selection = {
    interactive: true,
    promptTenant: async () => tenant,
    promptUser: async ({ search }: { search: (input: { page: number; pageSize: number }) => Promise<{ users: typeof user[] }> }) =>
      (await search({ page: 1, pageSize: 10 })).users[0],
  };
  try {
    const first = resolveHealthCaseIdentity(context, producer, {}, directory, selection);
    const second = resolveHealthCaseIdentity(context, { ...producer, id: "another" }, {}, directory, selection);
    expect(await first).toEqual({ tenantId: tenant.id, userId: user.id });
    expect(await second).toEqual(await first);
    expect([tenants, users]).toEqual([1, 1]);
    expect(context.profile.pluginConfig).toEqual({});
  } finally { await context.disposeClients(); }
});

test("configured identities skip interaction; CLI tenant changes never reuse another tenant's user", async () => {
  const declared = { ...producer, requestIdentity: { configured: () => ({ tenantId: tenant.id, userId: user.id }) } };
  const context = new CommandContext({});
  try {
    expect(await resolveHealthCaseIdentity(context, declared, {}, unavailableDirectory, { interactive: false }))
      .toEqual({ tenantId: tenant.id, userId: user.id });
    await expect(resolveHealthCaseIdentity(context, declared, { tenantId: "tenant-b" }, unavailableDirectory, { interactive: false }))
      .rejects.toThrow("未执行 Case");
    expect(await resolveHealthCaseIdentity(context, declared, { tenantId: "tenant-b", userId: "user-b" }, unavailableDirectory, { interactive: false }))
      .toEqual({ tenantId: "tenant-b", userId: "user-b" });
  } finally { await context.disposeClients(); }
});

test("-y never fabricates an identity or opens an interactive selector", async () => {
  const context = new CommandContext({});
  try {
    await expect(withInteractionOptions({ yes: true }, () =>
      resolveHealthCaseIdentity(context, producer, {}, unavailableDirectory, { interactive: true })))
      .rejects.toThrow("--tenant-id / --user-id");
  } finally { await context.disposeClients(); }
});

test("identity cancellation is shared without poisoning a different tenant's selection", async () => {
  const context = new CommandContext({});
  let prompts = 0;
  try {
    for (const id of ["one", "two"]) {
      expect(await resolveHealthCaseIdentity(context, { ...producer, id }, {}, {
        ...unavailableDirectory, listActive: async () => [tenant],
      }, { interactive: true, promptTenant: async () => { prompts++; return undefined; } })).toBeUndefined();
    }
    expect(prompts).toBe(1);
    expect(context.signal.aborted).toBe(false);
    expect(await resolveHealthCaseIdentity(context, producer, { tenantId: "tenant-b" }, {
      ...unavailableDirectory, searchActiveUsers: async () => ({ users: [user], total: 1 }),
    }, {
      interactive: true, promptUser: async () => user,
    })).toEqual({ tenantId: "tenant-b", userId: user.id });
  } finally { await context.disposeClients(); }
});

test("shared tenant decisions distinguish explicit parameters and Case identity from query scope", async () => {
  const context = new CommandContext({});
  const input = { commandContext: context, directory: { ...unavailableDirectory, listActive: async () => [tenant] },
    interactive: true, prompt: async () => tenant };
  try {
    expect((await resolveTenant(input))?.id).toBe(tenant.id);
    expect((await resolveTenant({ ...input, tenantId: "explicit" }))?.id).toBe("explicit");
    expect((await resolveTenant({ ...input, scope: "case-identity", prompt: async () => ({ ...tenant, id: "probe" }) }))?.id).toBe("probe");
  } finally { await context.disposeClients(); }
});

test("prepare binds identities without target access; run preserves fresh production per replica", async () => {
  const component = { name: "test", repository: { forge: { name: "test" }, path: "test" } };
  const binding = { id: "hello", workload: "main", producer: { namespace: "plugin/test/service/source", extension: "hello" } };
  const consume = { id: "requests", kind: "case.consume" as const, access: {},
    run: withSummary({ title: "Requests", fields: [] }, async () => ({ bindings: [binding] })) };
  const consumer = { name: "worker", component, workloads: [kubernetesServiceWorkload("worker")], extensions: [consume] };
  const source = { name: "source", component, workloads: [], extensions: [producer] };
  const plugin = { id: "test", version: "1", services: createServiceCatalog([consumer, source]) };
  const signal = new AbortController().signal;
  const identity: ServiceRequestIdentity = { tenantId: tenant.id, userId: user.id };
  const calls: string[] = [];
  const prepared = await prepareServiceCases(plugin, consumer, [consume], undefined, {
    signal,
    consume: async (_service, _extension, query) => { expect(query.tenantId).toBeUndefined(); calls.push("consume"); return { bindings: [binding] }; },
    identity: async () => { calls.push("identity"); return identity; },
  });
  expect(calls).toEqual(["consume", "identity"]);
  const result = await checkServiceCases(prepared, {
    signal, directory: "/unused", checkpoint: () => {},
    targets: async () => { calls.push("targets"); return { targets: ["one", "two"].map(pod =>
      ({ platform: "kubernetes" as const, environment: "test", workload: "main", namespace: "test", pod, uid: pod, container: "server" })) }; },
    sender: async target => { calls.push(target.pod); return async () => { throw new Error("empty producer cannot send"); }; },
    approve: async () => { throw new Error("identity must not approve requests"); },
    produce: async (_service, _extension, query) => {
      calls.push("produce");
      expect(query.requestIdentity).toEqual(identity);
      expect(query.tenantId).toBeUndefined();
      return { cases: [], reason: "No sample" };
    },
  });
  expect(calls).toEqual(["consume", "identity", "targets", "one", "produce", "two", "produce"]);
  expect(JSON.stringify(result)).not.toContain(user.id);
});

test("missing or cancelled identity is a binding-level gap and does not block identity-free producers", async () => {
  const component = { name: "test", repository: { forge: { name: "test" }, path: "test" } };
  const plain = { ...producer, id: "plain", requestIdentity: undefined };
  const binding = (id: string) => ({ id, workload: "main", producer: { namespace: "plugin/test/service/source", extension: id } });
  const consume = { id: "requests", kind: "case.consume" as const, access: {},
    run: withSummary({ title: "Requests", fields: [] }, async () => ({ bindings: [] })) };
  const consumer = { name: "worker", component, workloads: [kubernetesServiceWorkload("worker")], extensions: [consume] };
  const plugin = { id: "test", version: "1", services: createServiceCatalog([consumer,
    { name: "source", component, workloads: [], extensions: [producer, plain] }]) };
  for (const cancelled of [false, true]) {
    const prepared = await prepareServiceCases(plugin, consumer, [consume], undefined, {
      signal: new AbortController().signal,
      consume: async () => ({ bindings: [binding("hello"), binding("plain")] }),
      identity: async () => { if (!cancelled) throw new Error("missing identity"); return undefined; },
    });
    expect(prepared[0]?.execution).toBeUndefined();
    expect(prepared[0]?.result).toMatchObject({ stage: "identity", status: cancelled ? "cancelled" : "unavailable", targets: [], attempts: [] });
    expect(prepared[1]?.execution?.producer).toBe(plain);
  }
});
