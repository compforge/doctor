import { expect, test } from "bun:test";
import { CommandContext } from "../src/command";
import {
  selectionCandidateLabel,
  selectionPurposeKey,
  selectionTitle,
} from "../src/terminal/selection-context";

test("SelectionContext 统一表达选择目的和候选角色", () => {
  const configurationSource = {
    candidateRole: "配置来源",
    purpose: "读取 Service 'kb-server' 的 vdb Store 'trace' 运行时配置",
  };
  expect(selectionCandidateLabel(configurationSource, "Container")).toBe("配置来源 Container");
  expect(selectionTitle(configurationSource, "Pod")).toBe(
    "[collect] 读取 Service 'kb-server' 的 vdb Store 'trace' 运行时配置，请选择配置来源 Pod：",
  );

  expect(selectionTitle({ purpose: "确定日志采集范围" }, "Service")).toBe(
    "[collect] 确定日志采集范围，请选择 Service：",
  );
});

test("同一 command 内按 purpose、候选类型和作用域复用选择", async () => {
  const context = new CommandContext({});
  const selection = { purpose: "读取 VDB Store 运行时配置" };
  const podKey = selectionPurposeKey(selection, "Pod", ["default"]);
  let asked = 0;

  const selectPod = () => context.resolveSelection(podKey, async () => {
    asked += 1;
    return "kb-server-1";
  });
  expect(await Promise.all([selectPod(), selectPod()])).toEqual([
    "kb-server-1",
    "kb-server-1",
  ]);
  expect(asked).toBe(1);

  expect(selectionPurposeKey(selection, "Container", ["default", "kb-server-1"]))
    .not.toBe(podKey);
  expect(selectionPurposeKey({ purpose: "采集 Pod 日志" }, "Pod", ["default"]))
    .not.toBe(podKey);
});

test("取消会被复用，异常不会污染后续选择", async () => {
  const context = new CommandContext({});
  let cancelledPrompts = 0;
  const cancelled = () => context.resolveSelection("cancelled", async () => {
    cancelledPrompts += 1;
    return undefined;
  });
  expect(await cancelled()).toBeUndefined();
  expect(await cancelled()).toBeUndefined();
  expect(cancelledPrompts).toBe(1);

  let attempts = 0;
  await expect(context.resolveSelection("retry", async () => {
    attempts += 1;
    throw new Error("temporary failure");
  })).rejects.toThrow("temporary failure");
  expect(await context.resolveSelection("retry", async () => {
    attempts += 1;
    return "pod-1";
  })).toBe("pod-1");
  expect(attempts).toBe(2);
});
