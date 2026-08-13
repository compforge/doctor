import { expect, test } from "bun:test";
import {
  CommandContext,
  defineCommandDecision,
  defineCommandDiscovery,
  defineExecutionRecord,
} from "../src/command";
import {
  resolveUserSelection,
  selectionCandidateLabel,
  selectionPurposeScope,
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
  let asked = 0;

  const selectPod = () => resolveUserSelection(
    context,
    selection,
    "Pod",
    ["default"],
    async () => {
      asked += 1;
      return "kb-server-1";
    },
  );
  expect(await Promise.all([selectPod(), selectPod()])).toEqual([
    "kb-server-1",
    "kb-server-1",
  ]);
  expect(asked).toBe(1);

  expect(selectionPurposeScope(selection, "Container", ["default", "kb-server-1"]))
    .not.toEqual(selectionPurposeScope(selection, "Pod", ["default"]));
  expect(selectionPurposeScope({ purpose: "采集 Pod 日志" }, "Pod", ["default"]))
    .not.toEqual(selectionPurposeScope(selection, "Pod", ["default"]));
});

test("Decision 复用取消结果，异常不会污染后续决策", async () => {
  const context = new CommandContext({});
  const decision = defineCommandDecision<string | undefined>("test.decision");
  let cancelledPrompts = 0;
  const cancelled = () => context.decide(decision, ["cancelled"], async () => {
    cancelledPrompts += 1;
    return undefined;
  });
  expect(await cancelled()).toBeUndefined();
  expect(await cancelled()).toBeUndefined();
  expect(cancelledPrompts).toBe(1);

  let attempts = 0;
  await expect(context.decide(decision, ["retry"], async () => {
    attempts += 1;
    throw new Error("temporary failure");
  })).rejects.toThrow("temporary failure");
  expect(await context.decide(decision, ["retry"], async () => {
    attempts += 1;
    return "pod-1";
  })).toBe("pod-1");
  expect(attempts).toBe(2);
});

test("Discovery 按作用域复用只读发现，异常后允许重新探测", async () => {
  const context = new CommandContext({});
  const discovery = defineCommandDiscovery<string>("test.discovery");
  let attempts = 0;
  const discover = () => context.discover(discovery, ["default"], async () => {
    attempts += 1;
    return "available";
  });
  expect(await Promise.all([discover(), discover()])).toEqual(["available", "available"]);
  expect(attempts).toBe(1);

  await expect(context.discover(discovery, ["retry"], async () => {
    throw new Error("temporary failure");
  })).rejects.toThrow("temporary failure");
  expect(await context.discover(discovery, ["retry"], async () => "ready")).toBe("ready");
});

test("ExecutionRecord 按作用域追加保存本次命令产生的中间结果", () => {
  const context = new CommandContext({});
  const createdContainer = defineExecutionRecord<{
    readonly pod: string;
    readonly container: string;
  }>("debug.environment.created");

  context.record(createdContainer, ["default", "app-0"], {
    pod: "app-0",
    container: "doctor-debug-1",
  });
  context.record(createdContainer, ["default", "app-0"], {
    pod: "app-0",
    container: "doctor-debug-2",
  });
  context.record(createdContainer, ["default", "app-1"], {
    pod: "app-1",
    container: "doctor-debug-3",
  });
  const records = context.records(createdContainer, ["default", "app-0"]);
  expect(records).toEqual([
    { pod: "app-0", container: "doctor-debug-1" },
    { pod: "app-0", container: "doctor-debug-2" },
  ]);
  expect(context.latestRecord(createdContainer, ["default", "app-0"]))
    .toEqual({ pod: "app-0", container: "doctor-debug-2" });

  (records as Array<unknown>).pop();
  expect(context.records(createdContainer, ["default", "app-0"])).toHaveLength(2);
});
