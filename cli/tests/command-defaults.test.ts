import { expect, spyOn, test } from "bun:test";
import { Command, Option } from "commander";
import { applyCommandDefaults } from "../src/app/command-defaults";
import { createDoctorProgram } from "../src/app/main";
import * as execution from "../src/app/command";

for (const name of ["inspect", "data", "trace", "log", "tenant", "metric", "collect", "sample"]) {
  test(`${name}: distribution defaults are visible in Help and explicit formats win`, async () => {
    const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
    try {
      for (const explicit of [false, true]) {
        const program = createDoctorProgram({ name: "samplectl", logLevel: "error", commandDefaults: { [name]: { format: "manifest" } } });
        const command = program.commands.find(item => item.name() === name)!;
        expect(command.helpInformation()).toMatch(/default:\s+"manifest"/);
        await program.parseAsync([name, ...(name === "collect" ? ["--include", "inspect"] : []), ...(explicit ? ["-f", "html"] : [])], { from: "user" });
        expect(run.mock.calls.at(-1)![1].format).toBe(explicit ? "html" : "manifest");
        expect(run.mock.calls.at(-1)![2]).not.toHaveProperty("format");
        expect(run.mock.calls.at(-1)![3]).toMatchObject({ logLevel: "error" });
      }
      expect(createDoctorProgram().commands.find(item => item.name() === name)!.opts().format).toBeUndefined();
    } finally { run.mockRestore(); }
  });
}

test("unknown commands/options and invalid choice/boolean defaults fail offline", () => {
  expect(() => createDoctorProgram({ commandDefaults: { missing: { format: "manifest" } } })).toThrow("unknown command");
  expect(() => createDoctorProgram({ commandDefaults: { log: { missing: "value" } } })).toThrow("unknown option");
  expect(() => createDoctorProgram({ commandDefaults: { log: { format: "json" } } })).toThrow("invalid default");
  expect(() => createDoctorProgram({ commandDefaults: { log: { errorsOnly: "true" } } })).toThrow("invalid default");
});

test("defaults reuse parsers and remain below environment and CLI values", async () => {
  const previous = process.env.DOCTOR_TEST_DEFAULT;
  process.env.DOCTOR_TEST_DEFAULT = "5";
  try {
    for (const explicit of [false, true]) {
      const program = new Command();
      const command = program.command("sample").addOption(new Option("--count <n>").env("DOCTOR_TEST_DEFAULT").argParser(value => Number(value)));
      applyCommandDefaults(program, { sample: { count: 2 } });
      expect(command.opts().count).toBe(2);
      command.action(() => undefined);
      await program.parseAsync(["sample", ...(explicit ? ["--count", "8"] : [])], { from: "user" });
      expect(command.opts().count).toBe(explicit ? 8 : 5);
    }
  } finally { if (previous === undefined) delete process.env.DOCTOR_TEST_DEFAULT; else process.env.DOCTOR_TEST_DEFAULT = previous; }
});

function commandHelp(program: ReturnType<typeof createDoctorProgram>, name: string): string {
  const command = program.commands.find(item => item.name() === name)!;
  const output: string[] = [];
  command.configureOutput({ writeOut: value => { output.push(value); } });
  command.outputHelp();
  return output.join("");
}

test("Help shows each Distribution's effective format default and output destinations", () => {
  const upstream = commandHelp(createDoctorProgram(), "inspect");
  expect(upstream.replace(/\s+/g, " ")).toContain("当前默认 default（HTML + Bundle）");
  expect(upstream).toContain("-f default -o ./report → ./report.html 与 ./report.tar.gz（两个文件）");

  const ascli = createDoctorProgram({
    name: "ascli", commands: "inspect,data,db,trace",
    commandDefaults: { inspect: { format: "summary" }, data: { format: "summary" },
      db: { format: "manifest" }, trace: { format: "manifest" } },
  });
  const inspect = commandHelp(ascli, "inspect");
  expect(inspect.replace(/\s+/g, " ")).toContain("当前默认 summary（终端摘要与临时证据目录）");
  expect(inspect).toContain("-f json -o ./report.json → JSON 文件");
  expect(inspect).toContain("-f summary → 终端摘要；证据保存在临时目录，无需 -o");
  const db = commandHelp(ascli, "db");
  expect(db.replace(/\s+/g, " ")).toContain("当前默认 manifest（JSON 索引与临时证据目录）");
  expect(db).toContain("-f manifest -o ./evidence → ./evidence/manifest.json（证据目录）");
  const trace = commandHelp(ascli, "trace");
  expect(trace).not.toContain("-f json -o");
  expect(trace).not.toContain("-f summary →");
});
