import { expect, test } from "bun:test";
import {
  createMultiSelectState,
  filterMultiSelectChoices,
  reduceMultiSelectState,
} from "../src/terminal/multi-select";
import { prepareTerminalInput } from "../src/terminal/input";

const CHOICES = [
  { name: "frontend" },
  { name: "catalog" },
  { name: "workspace" },
];

test("多选光标循环移动并保留默认选择", () => {
  let state = createMultiSelectState(CHOICES, ["catalog", "unknown"]);
  expect([...state.selected]).toEqual(["catalog"]);
  state = reduceMultiSelectState(state, { type: "move", delta: -1 }, CHOICES);
  expect(state.cursor).toBe(2);
  state = reduceMultiSelectState(state, { type: "move", delta: 1 }, CHOICES);
  expect(state.cursor).toBe(0);
});

test("Space 对当前光标项执行勾选和取消", () => {
  let state = createMultiSelectState(CHOICES, []);
  state = reduceMultiSelectState(state, { type: "toggle" }, CHOICES);
  expect([...state.selected]).toEqual(["frontend"]);
  state = reduceMultiSelectState(state, { type: "toggle" }, CHOICES);
  expect([...state.selected]).toEqual([]);
});

test("关键词不区分大小写过滤候选", () => {
  expect(filterMultiSelectChoices(CHOICES, "FRONTEND")).toEqual([CHOICES[0]]);
  expect(filterMultiSelectChoices(CHOICES, "CATALOG")).toEqual([
    { name: "catalog" },
  ]);
  expect(filterMultiSelectChoices(CHOICES, "missing")).toEqual([]);
});

test("Ink 结束后的下一个 prompt 会重新 ref 并 resume stdin", () => {
  const calls: string[] = [];
  prepareTerminalInput({
    ref: () => {
      calls.push("ref");
      return undefined as never;
    },
    resume: () => {
      calls.push("resume");
      return undefined as never;
    },
  });
  expect(calls).toEqual(["ref", "resume"]);
});
