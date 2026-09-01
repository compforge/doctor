import { expect, test } from "bun:test";
import type { ServiceInspect } from "@compforge/doctor-plugin";
import { normalizeServiceInspectResult } from "../src/plugin/inspect";

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
  inspect: async (_context, query) => ({
    resolution: {
      inputId: query.identity.value,
      resolvedAs: query.identity.kind,
      identifiers: {},
    },
    facts: [],
  }),
} satisfies ServiceInspect;

const identity = { kind: "tenant_id", value: "tenant-1" };
const budget = { maxFacts: 10, maxBytes: 1024 * 1024 };

test("Inspect query 支持 ValueFact、RecordFact 与 RelationFact", () => {
  const result = normalizeServiceInspectResult({
    value: {
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id", identifiers: {} },
      facts: [{
        factType: "value",
        kind: "tenant-configuration",
        schemaVersion: 1,
        value: { enabled: true },
      }, {
        factType: "record",
        kind: "intention",
        schemaVersion: 1,
        recordKey: "one",
        record: { id: "one" },
      }, {
        factType: "record",
        kind: "intention",
        schemaVersion: 1,
        recordKey: "two",
        record: { id: "two" },
      }, {
        factType: "relation",
        kind: "owns",
        schemaVersion: 1,
        from: identity,
        to: { kind: "bot_id", value: "bot-1" },
      }],
    },
    service: "control",
    queryIdentity: identity,
    capability,
    budget,
  });

  expect(result.facts.map((fact) => [fact.factType, fact.kind])).toEqual([
    ["value", "tenant-configuration"],
    ["record", "intention"],
    ["record", "intention"],
    ["relation", "owns"],
  ]);
});

test("Inspect query 拒绝重复 ValueFact 与 RecordFact key", () => {
  expect(() => normalizeServiceInspectResult({
    value: {
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id", identifiers: {} },
      facts: [{ factType: "value", kind: "intention", schemaVersion: 1, value: "one" },
        { factType: "value", kind: "intention", schemaVersion: 1, value: "two" }],
    },
    service: "control",
    queryIdentity: identity,
    capability,
    budget,
  })).toThrow("duplicate ValueFact kind 'intention'");

  expect(() => normalizeServiceInspectResult({
    value: {
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id", identifiers: {} },
      facts: [{ factType: "record", kind: "intention", schemaVersion: 1, recordKey: "one", record: {} },
        { factType: "record", kind: "intention", schemaVersion: 1, recordKey: "one", record: {} }],
    },
    service: "control",
    queryIdentity: identity,
    capability,
    budget,
  })).toThrow("duplicate RecordFact 'intention:one'");
});

test("Inspect Fact 必须声明正整数 schemaVersion", () => {
  expect(() => normalizeServiceInspectResult({
    value: {
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id", identifiers: {} },
      facts: [{ factType: "value", kind: "intention", schemaVersion: 0, value: "one" }],
    },
    service: "control",
    queryIdentity: identity,
    capability,
    budget,
  })).toThrow("control inspect result.facts[0].schemaVersion must be a positive integer");
});

test("Inspect query 拒绝未声明 Fact 与不可信 Relation", () => {
  expect(() => normalizeServiceInspectResult({
    value: {
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id", identifiers: {} },
      facts: [{ factType: "value", kind: "unknown", schemaVersion: 1, value: {} }],
    },
    service: "control",
    queryIdentity: identity,
    capability,
    budget,
  })).toThrow("control inspect result.facts[0].kind 'unknown' is not declared by provides");

  expect(() => normalizeServiceInspectResult({
    value: {
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id", identifiers: {} },
      facts: [{
        factType: "relation",
        kind: "owns",
        schemaVersion: 1,
        from: identity,
        to: { kind: "message_id", value: "message-1" },
      }],
    },
    service: "control",
    queryIdentity: identity,
    capability,
    budget,
  })).toThrow("is not declared by expands");
});

test("Core 按预算截断 query result", () => {
  const result = normalizeServiceInspectResult({
    value: {
      resolution: { inputId: "tenant-1", resolvedAs: "tenant_id", identifiers: {} },
      facts: [{ factType: "record", kind: "intention", schemaVersion: 1, recordKey: "one", record: {} },
        { factType: "record", kind: "intention", schemaVersion: 1, recordKey: "two", record: {} }],
    },
    service: "control",
    queryIdentity: identity,
    capability,
    budget: { ...budget, maxFacts: 1 },
  });

  expect(result.facts).toHaveLength(1);
  expect(result.truncated).toEqual({
    reason: "Core Fact budget omitted 1 item(s) (maxFacts=1, maxBytes=1048576)",
    omittedFacts: 1,
  });
});
