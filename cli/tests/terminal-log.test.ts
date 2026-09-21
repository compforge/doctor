import { withTerminalInput } from "../src/terminal/interaction";
import { expect, spyOn, test } from "bun:test";
import { useLogger, withLogger, type LogLevel } from "../src/terminal/log";
import { writeOutput, writeMachineResult } from "../src/terminal/output";

function capture() {
  let stdout = "", stderr = "";
  const out = spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(); return true; });
  const err = spyOn(process.stderr, "write").mockImplementation(chunk => { stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(); return true; });
  return { stdout: () => stdout, stderr: () => stderr, restore() { out.mockRestore(); err.mockRestore(); } };
}

for (const level of ["silent", "info", "verbose"] as const) {
  test(`${level} filters process logs and always retains errors`, () => {
    const output = capture();
    try {
      withLogger(level, () => {
        const logger = useLogger("collect");
        logger.info("found pods"); logger.warn("partial coverage"); logger.success("finished");
        logger.debug("query detail"); logger.trace("trace detail"); logger.error("failed request");
      });
      expect(output.stderr()).toContain("failed request");
      expect(output.stdout().includes("found pods")).toBe(level !== "silent");
      expect(output.stdout().includes("partial coverage")).toBe(level !== "silent");
      expect(output.stdout().includes("finished")).toBe(level !== "silent");
      expect(output.stdout().includes("query detail")).toBe(level === "verbose");
      expect(output.stdout().includes("trace detail")).toBe(level === "verbose");
      expect(output.stderr()).not.toContain("partial coverage");
    } finally { output.restore(); }
  });
}

test("concurrent scopes retain tagged logger policy across awaits and restore it after failure", async () => {
  const output = capture();
  const run = (level: LogLevel, tag: string) => withLogger(level, async () => {
    const logger = useLogger(tag);
    await Promise.resolve(); logger.info(`${tag} progress`); logger.error(`${tag} error`);
  });
  try {
    await Promise.all([run("silent", "quiet"), run("info", "visible")]);
    expect(output.stdout()).not.toContain("quiet progress");
    expect(output.stdout()).toContain("visible progress");
    expect(output.stderr()).toContain("quiet error");
    expect(output.stderr()).toContain("visible error");
    expect(() => withLogger("silent", () => { throw new Error("stop"); })).toThrow("stop");
    useLogger().info("restored"); expect(output.stdout()).toContain("restored");
  } finally { output.restore(); }
});

test("silent logging preserves exact result and prompt bytes; format never changes logging", () => {
  const output = capture();
  try {
    withLogger("silent", () => { writeOutput("Choose: "); writeOutput(new Uint8Array([65, 10])); });
    expect(output.stdout()).toBe("Choose: A\n");
    withLogger("info", () => { useLogger().info("progress"); writeMachineResult({ ok: true }); });
    expect(output.stdout()).toContain("progress");
    expect(output.stdout()).toContain(JSON.stringify({ ok: true }, null, 2));
    expect(output.stderr()).toBe("");
  } finally { output.restore(); }
});


test("Consola defers background logs while an interactive prompt owns the terminal", async () => {
  const output = capture();
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  const prompt = withTerminalInput(async () => {
    writeOutput("Choose: "); entered(); await done; writeOutput("answer\n");
  });
  try {
    await ready;
    withLogger("info", () => useLogger("collect").info("background progress"));
    expect(output.stdout()).toBe("Choose: ");
    finish(); await prompt;
    expect(output.stdout()).toStartWith("Choose: answer\n");
    expect(output.stdout()).toContain("[collect] background progress");
  } finally { finish(); await prompt; output.restore(); }
});
