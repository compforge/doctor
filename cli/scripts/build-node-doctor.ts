import { chmodSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { commandSelectionDefine } from "./command-selection";

/** Bundle application dependencies, but leave the Node runtime to the receiving Host. */
export async function buildNodeDoctor(options: { entry: string; outfile: string; commands?: string }): Promise<void> {
  const outfile = resolve(options.outfile);
  const filename = basename(outfile);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/.test(filename)) {
    throw new Error("Node bundle outfile must have a simple .mjs filename");
  }
  const result = await Bun.build({
    entrypoints: [resolve(options.entry)],
    target: "node",
    format: "esm",
    outdir: dirname(outfile),
    naming: { entry: filename },
    define: commandSelectionDefine(options.commands ?? "all"),
  });
  if (!result.success) throw new AggregateError(result.logs, "Doctor Node bundle build failed");

  // Keep .mjs beside a small launcher: ESM loading must not depend on the customer's package.json.
  const launcher = outfile.slice(0, -4);
  writeFileSync(launcher, `#!/bin/sh\nexec node "$(dirname "$0")/${filename}" "$@"\n`, { mode: 0o755 });
  chmodSync(launcher, 0o755);
  process.stdout.write(`built: ${launcher} + ${filename} (external Node >= 22.23.1; no embedded runtime)\n`);
}

if (import.meta.main) {
  function argument(name: string): string {
    const index = Bun.argv.indexOf(name);
    const value = index >= 0 ? Bun.argv[index + 1] : undefined;
    if (!value) throw new Error(`missing ${name}`);
    return value;
  }
  await buildNodeDoctor({
    entry: argument("--entry"), outfile: argument("--outfile"),
    commands: Bun.argv.includes("--commands") ? argument("--commands") : "all",
  });
}
