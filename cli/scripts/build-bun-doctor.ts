import { resolve } from "node:path";
import { commandSelectionDefine } from "./command-selection";

function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const target = argument("--target");
const outfile = resolve(argument("--outfile"));
const main = resolve(argument("--entry"));
const commands = Bun.argv.includes("--commands") ? argument("--commands") : "all";

const result = await Bun.build({
  entrypoints: [main],
  define: commandSelectionDefine(commands),
  compile: {
    target: target as Bun.Build.CompileTarget,
    outfile,
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

process.stdout.write(`built: ${outfile} (${target}; visible commands: ${commands}; external Doctor Toolkit)\n`);
