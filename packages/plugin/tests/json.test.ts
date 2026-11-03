import { expect, test } from "bun:test";
import { immutableJsonValue } from "../src";

test("JSON snapshot rejects coercion, sparse arrays, hidden state and executable properties", () => {
  let invoked = false;
  const getter = { get value() { invoked = true; return 1; } };
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), new Map(), [, 1], getter,
    { a: undefined }, { [Symbol()]: 1 }, Object.defineProperty({}, "hidden", { value: 1 }), circular]) {
    expect(() => immutableJsonValue(value, "data")).toThrow();
  }
  expect(invoked).toBe(false);
  const shared = { a: [true, null] };
  const saved = immutableJsonValue({ first: shared, second: shared }, "data");
  shared.a.push(false);
  expect(saved).toEqual({ first: { a: [true, null] }, second: { a: [true, null] } });
  expect(Object.isFrozen(saved)).toBe(true);
});
