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
const PYDUMP_VERSION = "0.1.0";
const FORK_PYHEAP_VERSION = "0.7.0+doctor.2";
const toolIds: Record<string, string> = {
  regctl: "regctl",
  "doctor-pcap": "doctor-pcap",
  pyheap_dump: "fork-pyheap-dumper",
  pydump: "pydump-collector",
  "pydump-injector": "pydump-injector",
  pydump_analyzer: "pydump-analyzer",
  "py-spy": "py-spy",
};

function toolId(name: string): string | undefined {
  const fixed = toolIds[name];
  if (fixed) return fixed;
  const agent = /^pydump-agent-(3\.\d+)-min-glibc-(\d+(?:\.\d+)+)-(?:x86_64|aarch64)\.so$/.exec(name);
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
  const toolIds = new Set(tools.map((tool) => tool.id));
  const bundles = [];
  if (toolIds.has("pydump-analyzer")) {
    bundles.push({
      id: "pydump-analysis",
      protocol: "pydump.analysis/v1",
      version: PYDUMP_VERSION,
      components: [{ role: "analyzer", kind: "tool", resourceId: "pydump-analyzer" }],
    });
  }
  if (toolIds.has("fork-pyheap-dumper")) {
    bundles.push({
      id: "pyheap-capture",
      protocol: "fork-pyheap.capture/v1",
      version: FORK_PYHEAP_VERSION,
      components: [{ role: "dumper", kind: "tool", resourceId: "fork-pyheap-dumper" }],
    });
  }
  for (const tool of tools) {
    const agent = /^pydump-agent-(3\.\d+)-min-glibc-(\d+(?:\.\d+)+)$/.exec(tool.id);
    if (!agent) continue;
    if (!toolIds.has("pydump-collector") || !toolIds.has("pydump-injector")) {
      throw new Error(`pydump Agent 缺少同平台 Collector 或 Injector: ${entry.name}/${tool.id}`);
    }
    bundles.push({
      id: "pydump-capture",
      protocol: "pydump.capture/v1",
      version: PYDUMP_VERSION,
      compatibility: {
        runtime: { name: "cpython", version: agent[1] },
        libc: { family: "glibc", minimumVersion: agent[2] },
      },
      components: [
        { role: "collector", kind: "tool", resourceId: "pydump-collector" },
        { role: "injector", kind: "tool", resourceId: "pydump-injector" },
        { role: "agent", kind: "tool", resourceId: tool.id },
      ],
    });
  }
  bundles.sort((left, right) => JSON.stringify([
    left.id,
    left.protocol,
    left.compatibility ?? null,
  ]).localeCompare(JSON.stringify([
    right.id,
    right.protocol,
    right.compatibility ?? null,
  ])));
  platforms.push({
    os: match[1],
    architecture: match[2],
    tools: tools.sort((left, right) => left.id.localeCompare(right.id)),
    images: await listResources(join(platformRoot, "images"), {
      "doctor-debug.tar": "doctor-debug",
    }),
    packages: await listResources(join(platformRoot, "packages"), {}),
    bundles,
  });
}
platforms.sort((left, right) =>
  `${left.os}/${left.architecture}`.localeCompare(`${right.os}/${right.architecture}`));

writeFileSync(join(root, "manifest.json"), `${JSON.stringify({
  schema: "doctor.toolkit/v2",
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
