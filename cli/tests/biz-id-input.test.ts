import { expect, test } from "bun:test";
import { Command } from "commander";
import {
  normalizeBizIdOptions,
  normalizeBizIds,
  withBizIdInputs,
} from "../src/app/biz-id-input";

test("biz-id 支持 positional、重复 option 与去重", async () => {
  let captured: string[] = [];
  await withBizIdInputs(new Command("trace"), "业务 ID")
    .exitOverride()
    .action((positional, opts) => {
      captured = normalizeBizIds(positional, opts);
    })
    .parseAsync(["node", "trace", "first", "--biz-id=second", "--biz-id", "first"]);

  expect(captured).toEqual(["first", "second"]);
});

test("归一化后不把 Commander 的 bizId 数组传入 collect", () => {
  expect(normalizeBizIdOptions(["first"], { bizId: [], profile: "test" })).toEqual({
    bizIds: ["first"],
    profile: "test",
  });
});
