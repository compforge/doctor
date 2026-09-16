import { expect, spyOn, test } from "bun:test";
import { Command, Option } from "commander";
import { applyCommandDefaults } from "../src/app/command-defaults";
import { createDoctorProgram } from "../src/app/main";
import * as execution from "../src/app/command";

for (const name of ["inspect", "data", "trace", "log", "tenant", "metric", "collect", "overview"]) {
  test(`${name}: distribution defaults are visible in Help and explicit formats win`, async () => {
    const run = spyOn(execution, "runCommand").mockResolvedValue(undefined);
    try {
      for (const explicit of [false, true]) {
        const program = createDoctorProgram({ name: "samplectl", commandDefaults: { [name]: { format: "manifest" } } });
        const command = program.commands.find(item => item.name() === name)!;
        expect(command.helpInformation()).toMatch(/default:\s+"manifest"/);
        await program.parseAsync([name, ...(name === "collect" ? ["--include", "inspect"] : []), ...(explicit ? ["-f", "html"] : [])], { from: "user" });
        expect(run.mock.calls.at(-1)![1].format).toBe(explicit ? "html" : "manifest");
        expect(run.mock.calls.at(-1)![2]).not.toHaveProperty("format");
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
