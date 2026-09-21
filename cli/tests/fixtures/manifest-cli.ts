import { serializeEvidenceResult } from "../../src/collect/serialize";
import { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandStatus, defineCommand } from "../../src/command";
import { runCommand } from "../../src/app/command";
import { applyCommandDefaults, deliveryFormatOption } from "../../src/app/command-defaults";
import { useLogger } from "../../src/terminal/log";

const program = new Command("samplectl");
program.command("collect").addOption(deliveryFormatOption(["bundle", "html"]))
  .option("-o, --output <directory>").option("--config <path>")
  .action(async options => {
    const leaf = defineCommand({ name: "doctor log", serialize: serializeEvidenceResult, prepare: async (_context, input) => input, run: async (context) => {
      useLogger().info("collecting evidence\n");
      const path = join(process.cwd(), "source");
      mkdirSync(join(path, "raw"), { recursive: true });
      writeFileSync(join(path, "raw", "log.txt"), "captured log");
      const artifact = context.artifacts.add({ command: "log", path });
      return { status: CommandStatus.Partial as const, output: undefined, artifacts: [artifact] };
    } });
    const parent = defineCommand({ name: "doctor collect", prepare: async (_context, input) => input, run: async (context) => {
      const result = await leaf.run(context, {});
      return { status: result.status, output: { child: result }, artifacts: result.artifacts };
    }, serialize: async (context, result) => ({ files: {}, children: result.output ? [await context.serialize(leaf, result.output.child)] : [] }),
      render: async () => { throw new Error("renderer must not be invoked"); } });
    await runCommand(parent, options, {}, { logLevel: "silent" });
  });
applyCommandDefaults(program, { collect: { format: "manifest" } });
await program.parseAsync(process.argv);
