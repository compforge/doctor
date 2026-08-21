import { expect, test } from "bun:test";
import type { ServiceInspectCapability } from "@compforge/doctor-plugin";
import { normalizeServiceInspectFacts } from "../src/plugin/inspect";

const capability = {
  access: {},
  accepts: ["tenant_id"],
  provides: ["intention", "tenant-configuration"],
  expands: ["bot_id"],
  resolveTarget: async () => ({
    endpoint: "http://control",
    database: "control",
    username: "reader",
    credentialSource: "test",
  }),
  query: async () => [],
  summarize: () => ({ resolvedAs: "tenant_id", identifiers: {} }),
  detect: () => [],
} satisfies ServiceInspectCapability;

const identity = { kind: "tenant_id", value: "tenant-1" };

test("Inspect query 可返回多个独立 Fact", () => {
  expect(normalizeServiceInspectFacts({
    value: [{
      kind: "intention",
      service: "control",
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id" },
    }, {
      kind: "tenant-configuration",
      service: "control",
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id" },
    }],
    service: "control",
    queryIdentity: identity,
    capability,
  }).map((fact) => fact.kind)).toEqual(["intention", "tenant-configuration"]);
});

test("Inspect query 拒绝未声明 Fact 与不可信 Relation", () => {
  expect(() => normalizeServiceInspectFacts({
    value: [{
      kind: "unknown",
      service: "control",
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id" },
    }],
    service: "control",
    queryIdentity: identity,
    capability,
  })).toThrow("control inspect fact[0].kind 'unknown' is not declared by provides");

  expect(() => normalizeServiceInspectFacts({
    value: [{
      kind: "intention",
      service: "control",
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id" },
      relations: [{
        kind: "owns",
        from: identity,
        to: { kind: "message_id", value: "message-1" },
      }],
    }],
    service: "control",
    queryIdentity: identity,
    capability,
  })).toThrow("is not declared by expands");
});
