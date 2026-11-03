import { expect, test } from "bun:test";
import { immutableJsonValue, immutableJsonObject, type JsonInput } from "../src";

test("JSON snapshot rejects coercion, sparse arrays, hidden state and executable properties", () => {
  let invoked = false;
  const getter = { get value() { invoked = true; return 1; } };
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), new Map(), [, 1], [undefined], getter,
    { [Symbol()]: undefined }, Object.defineProperty({}, "hidden", { value: 1 }), circular]) {
    expect(() => immutableJsonValue(value, "data")).toThrow();
  }
  expect(invoked).toBe(false);
  const shared = { a: [true, null] };
  const saved = immutableJsonValue({ first: shared, second: shared }, "data");
  shared.a.push(false);
  expect(saved).toEqual({ first: { a: [true, null] }, second: { a: [true, null] } });
  expect(Object.isFrozen(saved)).toBe(true);
});

/** @case Optional object properties are absent at every depth, while explicit null and zero survive. */
test("JSON normalization preserves protocol meaning without mutating producer objects", () => {
  const source: JsonInput = { absent: undefined, clear: null, count: 0, nested: { missing: undefined, known: true },
    rows: [{ label: undefined, value: "retained" }] };
  const saved = immutableJsonObject(source, "data");
  expect(saved).toEqual({ clear: null, count: 0, nested: { known: true }, rows: [{ value: "retained" }] });
  expect(Object.hasOwn(saved, "absent")).toBe(false);
  expect(Object.hasOwn(source, "absent")).toBe(true);
  expect(Object.isFrozen(saved.nested)).toBe(true);
  expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
  expect(immutableJsonValue(saved, "data")).toEqual(saved);
});

test("undefined cannot hide array properties or executable object properties", () => {
  let invoked = false;
  const getter = { get absent() { invoked = true; return undefined; } };
  const hidden = Object.defineProperty({}, "absent", { value: undefined });
  const array = Object.assign([1], { absent: undefined });
  for (const value of [getter, hidden, array]) expect(() => immutableJsonValue(value, "data")).toThrow();
  expect(invoked).toBe(false);
});

// @ts-expect-error Missing root values are not encoder input.
const missingRoot: JsonInput = undefined;
// @ts-expect-error Array positions cannot represent absent values.
const missingElement: JsonInput = [undefined];
