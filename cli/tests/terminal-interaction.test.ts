import { expect, test } from "bun:test";
import { withTerminalInput } from "../src/terminal/interaction";
import { TerminalOutput } from "../src/terminal/output";
import { inCommandScope } from "../src/command/execution-scope";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("concurrent prompts have one input owner and background output resumes afterwards", async () => {
  const output: string[] = [];
  const terminal = new TerminalOutput({ write: (text) => { output.push(String(text)); return true; } });
  const entered = latch(), finish = latch();
  const first = withTerminalInput(async () => {
    terminal.write("first prompt"); entered.release(); await finish.promise;
    terminal.write("first answer");
  });
  await entered.promise;
  const second = withTerminalInput(async () => { terminal.write("second prompt"); });
  terminal.write("background collect");
  expect(output).toEqual(["first prompt"]);
  finish.release();
  await Promise.all([first, second]);
  expect(output).toEqual(["first prompt", "first answer", "background collect", "second prompt"]);
});

test("cancelled queued prompts never touch stdin and do not block later prompts", async () => {
  const entered = latch(), finish = latch();
  const first = withTerminalInput(async () => { entered.release(); await finish.promise; });
  await entered.promise;
  const controller = new AbortController();
  let started = false;
  const queued = inCommandScope(controller.signal, () => withTerminalInput(async () => { started = true; })).catch(() => "cancelled");
  controller.abort();
  expect(await queued).toBe("cancelled");
  expect(started).toBeFalse();
  finish.release(); await first;
  expect(await withTerminalInput(async () => "ready")).toBe("ready");
});
