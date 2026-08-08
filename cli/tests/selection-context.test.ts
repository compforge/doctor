import { expect, test } from "bun:test";
import {
  selectionCandidateLabel,
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
