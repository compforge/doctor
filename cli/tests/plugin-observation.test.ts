import { expect, test } from "bun:test";
import {
  defineObservation,
  Type,
} from "@compforge/doctor-plugin";
import {
  immutableJsonValue,
  validateObservationSchema,
  validateObservationValue,
} from "../src/plugin/observation";

const HealthObservation = defineObservation({
  kind: "health",
  schemaVersion: 1,
  schema: Type.Object({
    ready: Type.Boolean(),
    details: Type.Object({ latencyMs: Type.Number() }, { additionalProperties: false }),
  }, { additionalProperties: false }),
});

test("Core 接收符合 schema 的 Observation 并保留不可变 JSON 快照", () => {
  const source = { ready: true, details: { latencyMs: 12 } };
  const snapshot = validateObservationValue(HealthObservation, source, "health-probe");

  expect(snapshot).toEqual(source);
  expect(snapshot).not.toBe(source);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.details)).toBe(true);
});

test("Core 拒绝不符合 schema 的 Observation，不做类型强转或额外字段剔除", () => {
  expect(() => validateObservationValue(
    HealthObservation,
    { ready: "true", details: { latencyMs: 12 } },
    "health-probe",
  )).toThrow("/ready must be boolean");
  expect(() => validateObservationValue(
    HealthObservation,
    { ready: true, details: { latencyMs: 12 }, ignored: true },
    "health-probe",
  )).toThrow("must NOT have additional properties");
});

test("Core 在 schema 验证前拒绝会被 JSON.stringify 静默改写的 JavaScript 值", () => {
  expect(() => validateObservationValue(
    HealthObservation,
    { ready: true, details: { latencyMs: Number.NaN } },
    "health-probe",
  )).toThrow("must be a finite JSON number");
  expect(() => immutableJsonValue({ omitted: undefined }, "payload"))
    .toThrow("contains unsupported JSON value 'undefined'");
  expect(() => immutableJsonValue({ at: new Date() }, "payload"))
    .toThrow("must be a plain JSON object");
});

test("Core 在 Plugin 加载时拒绝开放 object schema 和远程 $ref", () => {
  expect(() => validateObservationSchema({
    type: "object",
    properties: { ready: { type: "boolean" } },
  }, "open-schema")).toThrow("object schema must declare additionalProperties");
  expect(() => validateObservationSchema({
    type: "object",
    properties: {},
    additionalProperties: true,
  }, "open-schema")).toThrow("additionalProperties must be false or a constrained schema");
  expect(() => validateObservationSchema({
    type: "object",
    properties: { ready: { $ref: "https://example.com/health.json" } },
    additionalProperties: false,
  }, "remote-schema")).toThrow("must not use a remote $ref");
  expect(() => validateObservationSchema({
    type: "object",
    properties: { payload: {} },
    additionalProperties: false,
  }, "unconstrained-schema")).toThrow("must declare type, local $ref, or composition");
  expect(() => validateObservationSchema({
    type: "object",
    properties: { payload: true },
    additionalProperties: false,
  }, "unconstrained-schema")).toThrow("must not be an unconstrained schema");
  const refined = Type.Object({
    score: Type.Refine(Type.Number(), (value) => value > 0),
  }, { additionalProperties: false });
  expect(() => validateObservationSchema(refined, "refined-schema"))
    .toThrow("~refine\"] is not portable JSON Schema metadata");
});
