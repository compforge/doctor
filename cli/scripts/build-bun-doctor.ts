import { existsSync } from "node:fs";
import { resolve } from "node:path";

function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const target = argument("--target");
const outfile = resolve(argument("--outfile"));
const regctl = resolve(argument("--regctl"));
const gopacket = resolve(argument("--gopacket"));
const pyheapDumper = resolve(argument("--pyheap-dumper"));
const pyheapAnalyzer = resolve(argument("--pyheap-analyzer"));
const main = resolve(argument("--entry"));

if (!existsSync(regctl)) throw new Error(`regctl asset not found: ${regctl}`);
if (!existsSync(gopacket)) throw new Error(`gopacket asset not found: ${gopacket}`);
if (!existsSync(pyheapDumper)) throw new Error(`PyHeap dumper asset not found: ${pyheapDumper}`);
if (!existsSync(pyheapAnalyzer)) throw new Error(`PyHeap analyzer asset not found: ${pyheapAnalyzer}`);

const entryPlugin: Bun.BunPlugin = {
  name: "doctor-embedded-assets",
  setup(build) {
    build.onResolve({ filter: /^doctor:entry$/ }, () => ({
      path: "entry",
      namespace: "doctor",
    }));
    build.onLoad({ filter: /^entry$/, namespace: "doctor" }, () => ({
      loader: "ts",
      contents: `
        import regctlAsset from ${JSON.stringify(regctl)} with { type: "file" };
        import gopacketAsset from ${JSON.stringify(gopacket)} with { type: "file" };
        import pyheapDumperAsset from ${JSON.stringify(pyheapDumper)} with { type: "file" };
        import pyheapAnalyzerAsset from ${JSON.stringify(pyheapAnalyzer)} with { type: "file" };
        globalThis.__DOCTOR_REGCTL_ASSET__ = regctlAsset;
        globalThis.__DOCTOR_PCAP_ASSET__ = gopacketAsset;
        globalThis.__DOCTOR_PYHEAP_DUMPER_ASSET__ = pyheapDumperAsset;
        globalThis.__DOCTOR_PYHEAP_ANALYZER_ASSET__ = pyheapAnalyzerAsset;
        await import(${JSON.stringify(main)});
      `,
    }));
  },
};

const result = await Bun.build({
  entrypoints: ["doctor:entry"],
  plugins: [entryPlugin],
  compile: {
    target: target as Bun.Build.CompileTarget,
    outfile,
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

process.stdout.write(`built: ${outfile} (embedded ${target} regctl + doctor-pcap + PyHeap)\n`);
