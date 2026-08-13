import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const [version, stageArg, outputArg] = process.argv.slice(2);
if (!version || !stageArg || !outputArg) {
  throw new Error("usage: build-manifest.ts <version> <stage-root> <output.tar>");
}

const stage = resolve(stageArg);
const root = join(stage, "doctor-toolkit");
const platformsRoot = join(root, "platforms");
const output = resolve(outputArg);
const toolIds: Record<string, string> = {
  regctl: "regctl",
  "doctor-pcap": "doctor-pcap",
  pydump: "pydump-collector",
  "pydump-injector": "pydump-injector",
  pydump_analyzer: "pydump-analyzer",
  "py-spy": "py-spy",
};

function toolId(name: string): string | undefined {
  const fixed = toolIds[name];
  if (fixed) return fixed;
  const agent = /^pydump-agent-(3\.(?:10|11|12|13|14))-min-glibc-(2\.17)-(?:x86_64|aarch64)\.so$/.exec(name);
  return agent ? `pydump-agent-${agent[1]}-min-glibc-${agent[2]}` : undefined;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function resource(path: string, id: string) {
  return {
    id,
    path: relative(stage, path).replaceAll("\\", "/"),
    sha256: await sha256(path),
    size: statSync(path).size,
  };
}

async function listResources(directory: string, ids: Record<string, string>) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const resources = [];
  for (const item of entries.filter((entry) => entry.isFile())) {
    resources.push(await resource(join(directory, item.name), ids[item.name] ?? item.name));
  }
  return resources.sort((left, right) => left.id.localeCompare(right.id));
}

const platforms = [];
for (const entry of readdirSync(platformsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const match = /^(darwin|linux)-(amd64|arm64)$/.exec(entry.name);
  if (!match) throw new Error(`invalid toolkit platform directory: ${entry.name}`);
  const platformRoot = join(platformsRoot, entry.name);
  const binRoot = join(platformRoot, "bin");
  const tools = [];
  for (const item of readdirSync(binRoot, { withFileTypes: true })) {
    if (!item.isFile()) continue;
    const id = toolId(item.name);
    if (!id) throw new Error(`unknown toolkit tool: ${item.name}`);
    const path = join(binRoot, item.name);
    chmodSync(path, 0o755);
    tools.push(await resource(path, id));
  }
  platforms.push({
    os: match[1],
    architecture: match[2],
    tools: tools.sort((left, right) => left.id.localeCompare(right.id)),
    images: await listResources(join(platformRoot, "images"), {
      "doctor-debug.tar": "doctor-debug",
    }),
    packages: await listResources(join(platformRoot, "packages"), {}),
  });
}
platforms.sort((left, right) =>
  `${left.os}/${left.architecture}`.localeCompare(`${right.os}/${right.architecture}`));

writeFileSync(join(root, "manifest.json"), `${JSON.stringify({
  schema: "doctor.toolkit/v1",
  version,
  platforms,
}, null, 2)}\n`);
mkdirSync(dirname(output), { recursive: true });
const archived = Bun.spawnSync({
  cmd: ["tar", "--format", "ustar", "-cf", output, "doctor-toolkit"],
  cwd: stage,
  env: { ...process.env, COPYFILE_DISABLE: "1" },
  stdout: "inherit",
  stderr: "inherit",
});
if (archived.exitCode !== 0) {
  throw new Error(`unable to build toolkit: tar exited ${archived.exitCode}`);
}
console.log(`toolkit built: ${output}`);
