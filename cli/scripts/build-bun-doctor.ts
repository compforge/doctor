import { resolve } from "node:path";

function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const target = argument("--target");
const outfile = resolve(argument("--outfile"));
const main = resolve(argument("--entry"));

const result = await Bun.build({
  entrypoints: [main],
  compile: {
    target: target as Bun.Build.CompileTarget,
    outfile,
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

process.stdout.write(`built: ${outfile} (${target}; external Doctor Toolkit)\n`);
