import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PlainChatRenderer } from "../src/chat/plain-repl";
import type { DoctorModel } from "../src/chat/model";

function model(blocks: DoctorModel["blocks"], error: string | null = null): DoctorModel {
  return {
    blocks,
    meta: { error: error ? { code: "test", message: error } : null },
  } as DoctorModel;
}

test("兼容 renderer 只追加 message 的流式增量", () => {
  const writes: string[] = [];
  const renderer = new PlainChatRenderer((text) => writes.push(text));

  renderer.render(model([{ id: "answer", type: "message", role: "agent", content: "诊断", streaming: true }]));
  renderer.render(model([{ id: "answer", type: "message", role: "agent", content: "诊断完成", streaming: false }]));

  expect(writes.join("")).toBe("\ndoctor> 诊断完成\n");
});

test("兼容 renderer 不把 tool result 大段输出到终端", () => {
  const writes: string[] = [];
  const renderer = new PlainChatRenderer((text) => writes.push(text));

  renderer.render(model([{
    id: "tool-1",
    type: "tool",
    tool_name: "trace",
    status: "completed",
    result: "very large result",
  }]));

  expect(writes.join("")).toContain("[tool] trace: completed");
  expect(writes.join("")).not.toContain("very large result");
});

test("兼容 renderer 在新一轮问诊中可重复展示相同错误", () => {
  const writes: string[] = [];
  const renderer = new PlainChatRenderer((text) => writes.push(text));

  renderer.render(model([], "连接失败"));
  renderer.render(model([]));
  renderer.render(model([], "连接失败"));

  expect(writes.filter((text) => text.includes("连接失败"))).toHaveLength(2);
});

test("Kylin SEA 使用原生 ESM main，不再生成 Base64 data URL", () => {
  const script = readFileSync(resolve(import.meta.dir, "../scripts/build-linux-x64-legacy.sh"), "utf8");

  expect(script).toContain('"mainFormat": "module"');
  expect(script).not.toContain("data:text/javascript;base64");
});
