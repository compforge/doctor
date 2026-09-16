import { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandStatus, defineCommand } from "../../src/command";
import { runCommand } from "../../src/app/command";
import { applyCommandDefaults, deliveryFormatOption } from "../../src/app/command-defaults";
import { terminalStdout } from "../../src/terminal/output";

const program = new Command("samplectl");
program.command("collect").addOption(deliveryFormatOption(["bundle", "html"]))
  .option("-o, --output <directory>").option("--config <path>")
  .action(async options => {
    const leaf = defineCommand({ name: "doctor log", run: async (context) => {
      terminalStdout.write("collecting evidence\n");
      const path = join(process.cwd(), "source");
      mkdirSync(join(path, "raw"), { recursive: true });
      writeFileSync(join(path, "raw", "log.txt"), "captured log");
      const artifact = context.artifacts.add({ command: "log", path });
      return { status: CommandStatus.Partial as const, output: undefined, artifacts: [artifact] };
    } });
    const parent = defineCommand({ name: "doctor collect", run: (context) => leaf.run(context, {}),
      render: async () => { throw new Error("renderer must not be invoked"); } });
    await runCommand(parent, options, {});
  });
applyCommandDefaults(program, { collect: { format: "manifest" } });
await program.parseAsync(process.argv);
