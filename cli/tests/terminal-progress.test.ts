import { expect, test } from "bun:test";
import {
  formatTerminalProgress,
  TerminalProgressLine,
} from "../src/terminal/progress";

test("terminal progress 格式化字节、百分比和领域 detail", () => {
  expect(formatTerminalProgress({
    label: "[net] 回传 PCAP",
    current: 7 * 1024 * 1024,
    total: 14 * 1024 * 1024,
    detail: "2/5 Pod",
  })).toBe(
    "[net] 回传 PCAP [==========----------] 50%（7.0 MiB / 14.0 MiB，2/5 Pod）",
  );
});

test("terminal progress 在 TTY 单行刷新，普通日志插入前可结束活动行", () => {
  let output = "";
  const progress = new TerminalProgressLine({
    isTTY: true,
    write: (text) => {
      output += text;
    },
  });

  progress.update({ label: "copy", current: 1, total: 2 });
  progress.interrupt();
  progress.update({ label: "copy", current: 2, total: 2, complete: true });

  expect(output).toContain("\r\u001b[2Kcopy");
  expect(output.match(/\n/g)?.length).toBe(2);
});

test("terminal progress 在非 TTY 只保留约 10% 粒度和完成行", () => {
  const lines: string[] = [];
  const progress = new TerminalProgressLine({
    isTTY: false,
    write: (text) => lines.push(text),
  });
  progress.update({ label: "copy", current: 1, total: 100 });
  progress.update({ label: "copy", current: 5, total: 100 });
  progress.update({ label: "copy", current: 11, total: 100 });
  progress.update({ label: "copy", current: 11, total: 100, complete: true });
  progress.update({ label: "next", current: 1, total: 100 });

  expect(lines).toHaveLength(4);
  expect(lines.at(-1)).toContain("next");
});
