import { expect, test } from "bun:test";
import { logWorkloadsOutput } from "../src/extension/log";

test("log.workloads accepts an empty selection and only names belonging to its Service", () => {
  const declared = [{ name: "worker" }];
  expect(logWorkloadsOutput([], declared)).toEqual([]);
  expect(logWorkloadsOutput(["worker", "worker"], declared)).toEqual(["worker"]);
  for (const value of [undefined, {}, ["foreign"], [null]]) {
    expect(() => logWorkloadsOutput(value, declared)).toThrow("declared by its Service");
  }
});
