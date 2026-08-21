import { expect, test } from "bun:test";
import type { ServiceDataCapability } from "@compforge/doctor-plugin";
import { normalizeServiceDataFacts } from "../src/plugin/data";

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
} satisfies ServiceDataCapability;

const identity = { kind: "tenant_id", value: "tenant-1" };

test("Data query 可返回多个独立 Fact", () => {
  expect(normalizeServiceDataFacts({
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

test("Data query 拒绝未声明 Fact 与不可信 RelationFact", () => {
  expect(() => normalizeServiceDataFacts({
    value: [{
      kind: "unknown",
      service: "control",
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id" },
    }],
    service: "control",
    queryIdentity: identity,
    capability,
  })).toThrow("is not declared by provides");

  expect(() => normalizeServiceDataFacts({
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
