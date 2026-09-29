import { getNodeAssets, type NodeAssetTarget } from "@opentui/core/node-assets";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { commandSelectionDefine } from "./command-selection";

const NODE_VERSION = "26.4.0";
// Pin the build runtime and target runtime together: SEA blobs are Node-version specific.
const NODE_SHA256 = {
  "darwin-arm64": "4f4fbcacf6b1ff1a95deedba7bd7b2d79efecaa53a8ecb0530546dc9063fefbc",
  "darwin-x64": "eb3bdd8dec3ff2558ee10e284da7d2a3865af0cbda21f06d397b0265837c641e",
  "linux-arm64": "773d9ec67266838270ddc105c2548ae8aaff28bc8fe6f34c55d1094043c4165e",
  "linux-x64": "f221dab30d0e9d544332f06fbee2c62186c97d864d5cac8482dba34f1e38b8dc",
} as const;

type RuntimeTarget = keyof typeof NODE_SHA256;

function runtimeTarget(platform: string, arch: string): RuntimeTarget {
  const target = `${platform}-${arch}`;
  if (!(target in NODE_SHA256)) throw new Error(`Unsupported Node SEA platform: ${target}`);
  return target as RuntimeTarget;
}

function run(command: string, args: string[]): void {
  const result = Bun.spawnSync([command, ...args], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`SEA build command failed (${result.exitCode}): ${command}`);
}

async function downloadNode(target: RuntimeTarget, workDir: string): Promise<string> {
  const name = `node-v${NODE_VERSION}-${target}`;
  const archive = join(workDir, `${name}.tar.gz`);
  const response = await fetch(`https://nodejs.org/download/release/v${NODE_VERSION}/${name}.tar.gz`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Download Node ${target}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== NODE_SHA256[target]) throw new Error(`Node ${target} checksum mismatch: ${actual}`);
  writeFileSync(archive, bytes);
  run("tar", ["-xzf", archive, "-C", workDir, `${name}/bin/node`]);
  return join(workDir, name, "bin/node");
}

export async function buildNodeSeaDoctor(options: {
  entry: string;
  outfile: string;
  target: NodeAssetTarget;
  commands?: string;
}): Promise<void> {
  const host = runtimeTarget(process.platform, process.arch);
  const target = runtimeTarget(options.target.platform, options.target.arch);
  const define = commandSelectionDefine(options.commands ?? "all");
  const assets = getNodeAssets(options.target);
  const outfile = resolve(options.outfile);
  const workDir = mkdtempSync(join(tmpdir(), "doctor-sea-build-"));
  try {
    mkdirSync(dirname(outfile), { recursive: true });
    const buildNode = await downloadNode(host, workDir);
    const targetNode = host === target ? buildNode : await downloadNode(target, workDir);
    const result = await Bun.build({
      entrypoints: [resolve(options.entry)], target: "node", format: "esm",
      outdir: workDir, naming: "doctor.mjs", define,
    });
    if (!result.success) throw new AggregateError(result.logs, "Doctor SEA bundle build failed");

    // FFI and parser workers require real files. A private per-process directory avoids shared-cache
    // races or loading another user's native library; normal exit removes the extracted assets.
    const prelude = `
import { mkdtempSync as seaMkdtemp, mkdirSync as seaMkdir, writeFileSync as seaWrite, rmSync as seaRemove } from "node:fs";
import { tmpdir as seaTmpdir } from "node:os";
import { join as seaJoin, dirname as seaDirname } from "node:path";
import { getRawAsset as seaAsset } from "node:sea";
const seaRoot = seaMkdtemp(seaJoin(seaTmpdir(), "doctor-opentui-"));
process.once("exit", () => seaRemove(seaRoot, { recursive: true, force: true }));
for (const key of ${JSON.stringify(assets.map(({ key }) => key))}) {
  const dest = seaJoin(seaRoot, key);
  seaMkdir(seaDirname(dest), { recursive: true });
  seaWrite(dest, new Uint8Array(seaAsset(key)));
}
process.env.OTUI_ASSET_ROOT = seaRoot;
`;
    const main = join(workDir, "sea-main.mjs");
    const bundle = readFileSync(join(workDir, "doctor.mjs"), "utf8").replace(/^#![^\n]*\n/, "");
    writeFileSync(main, prelude + bundle);
    const config = join(workDir, "sea-config.json");
    writeFileSync(config, JSON.stringify({
      main, mainFormat: "module", executable: targetNode, output: outfile,
      disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
      execArgv: ["--experimental-ffi"], execArgvExtension: "none",
      assets: Object.fromEntries(assets.map(({ key, source }) => [key, source])),
    }));
    run(buildNode, ["--build-sea", config]);
    chmodSync(outfile, 0o755);
    if (options.target.platform === "darwin") run("codesign", ["--sign", "-", "--force", outfile]);
    process.stdout.write(`built: ${outfile} (Node ${NODE_VERSION} SEA; ${target}; OpenTUI)\n`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  function argument(name: string): string {
    const index = Bun.argv.indexOf(name);
    const value = index >= 0 ? Bun.argv[index + 1] : undefined;
    if (!value) throw new Error(`missing ${name}`);
    return value;
  }
  const arch = argument("--arch");
  if (arch !== "arm64" && arch !== "x64") throw new Error(`Unsupported Kylin architecture: ${arch}`);
  await buildNodeSeaDoctor({
    entry: argument("--entry"), outfile: argument("--outfile"),
    target: { platform: "linux", arch, libc: "glibc" },
    commands: Bun.argv.includes("--commands") ? argument("--commands") : "all",
  });
}
