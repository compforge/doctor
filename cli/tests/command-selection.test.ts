import { describe, expect, test } from "bun:test";
import { commandSelectionDefine } from "../scripts/command-selection";
import { createDoctorProgram } from "../src/app/main";

describe("build-time command visibility", () => {
  test("default build keeps every command visible", () => {
    const program = createDoctorProgram();
    const help = program.helpInformation();
    for (const command of program.commands) {
      expect(help).toMatch(new RegExp(`^  ${command.name()}(?: |$)`, "m"));
    }
  });

  test("arbitrary command selections affect both help entrypoints", async () => {
    const program = createDoctorProgram({ commands: "inspect, perf,inspect" });
    let output = "";
    program.configureOutput({ writeOut: text => { output += text; } });
    await program.parseAsync(["help"], { from: "user" });
    expect(output).toBe(program.helpInformation());
    expect(output).toMatch(/^  inspect /m);
    expect(output).toMatch(/^  perf /m);
    expect(output).toMatch(/^  help /m);
    expect(output).toMatch(/^  version /m);
    for (const name of ["chat", "collect", "data", "plugin", "init", "profile"]) {
      expect(output).not.toMatch(new RegExp(`^  ${name}(?: |$)`, "m"));
    }
  });

  test("hidden commands remain registered and directly callable", async () => {
    const program = createDoctorProgram({ commands: "inspect,data" });
    const chat = program.commands.find(command => command.name() === "chat")!;
    let output = "";
    chat.configureOutput({ writeOut: text => { output += text; } }).exitOverride();
    await expect(program.parseAsync(["chat", "--help"], { from: "user" }))
      .rejects.toMatchObject({ code: "commander.helpDisplayed", exitCode: 0 });
    expect(output).toContain("Usage: doctor chat");
    expect(output).toContain("--server");
  });

  test("selection preserves nested command registration and parent", () => {
    const program = createDoctorProgram({ commands: "plugin" });
    const plugin = program.commands.find(command => command.name() === "plugin")!;
    expect(plugin.parent).toBe(program);
    expect(plugin.commands.map(command => command.name())).toEqual(["install", "uninstall"]);
    expect(plugin.commands.every(command => command.parent === plugin)).toBe(true);
  });

  test("build definition is validated against the actual command catalog", () => {
    expect(commandSelectionDefine("inspect,data")).toEqual({ __DOCTOR_COMMANDS__: '"inspect,data"' });
    expect(commandSelectionDefine("all")).toEqual({ __DOCTOR_COMMANDS__: '"all"' });
    for (const selection of ["", "inspekt", "all,data", "data,", "plugin install"]) {
      expect(() => commandSelectionDefine(selection)).toThrow("Invalid DOCTOR_COMMANDS");
    }
  });
});
