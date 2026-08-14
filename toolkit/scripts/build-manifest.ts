import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  readFileSync,
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
const PYDUMP_CAPTURE_VERSION = "0.2.0";
const PYDUMP_ANALYSIS_VERSION = "0.1.0";
const FORK_PYHEAP_VERSION = "0.7.0+doctor.2";
const REGCTL_VERSION = "0.11.5";
const PY_SPY_VERSION = "0.4.2";
const toolIds: Record<string, string> = {
  regctl: "regctl",
  "doctor-pcap": "doctor-pcap",
  pyheap_dump: "fork-pyheap-dumper",
  pydump: "pydump-collector",
  "pydump-loader": "pydump-loader",
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

interface ResourceDeclaration {
  id: string;
  version: string;
  requirements: {
    software?: {
      os?: {
        ids?: string[];
        version?: { minInclusive?: string; maxExclusive?: string };
      };
      kernel?: { minInclusive?: string; maxExclusive?: string };
      libraries?: Array<{
        name: string;
        family?: string;
        version?: { minInclusive?: string; maxExclusive?: string };
      }>;
    };
    hardware?: {
      cpu?: {
        vendors?: string[];
        families?: string[];
        models?: string[];
        features?: string[];
      };
    };
  };
}

function toolDeclaration(name: string): ResourceDeclaration | undefined {
  const id = toolId(name);
  if (!id) return undefined;
  const agent = /^pydump-agent-(3\.\d+)-min-glibc-(\d+(?:\.\d+)+)$/.exec(id);
  if (agent) {
    return {
      id,
      version: PYDUMP_CAPTURE_VERSION,
      requirements: {
        software: {
          libraries: [{
            name: "libc",
            family: "glibc",
            version: { minInclusive: agent[2] },
          }],
        },
      },
    };
  }
  const versions: Record<string, string> = {
    regctl: REGCTL_VERSION,
    "doctor-pcap": version,
    "fork-pyheap-dumper": FORK_PYHEAP_VERSION,
    "pydump-collector": PYDUMP_CAPTURE_VERSION,
    "pydump-loader": PYDUMP_CAPTURE_VERSION,
    "pydump-analyzer": PYDUMP_ANALYSIS_VERSION,
    "py-spy": PY_SPY_VERSION,
  };
  return { id, version: versions[id]!, requirements: {} };
}

async function resource(path: string, declaration: ResourceDeclaration) {
  return {
    ...declaration,
    path: relative(stage, path).replaceAll("\\", "/"),
    sha256: await sha256(path),
    size: statSync(path).size,
  };
}

async function listResources(
  directory: string,
  declaration: (name: string) => ResourceDeclaration,
) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const resources = [];
  for (const item of entries.filter((entry) => entry.isFile())) {
    resources.push(await resource(join(directory, item.name), declaration(item.name)));
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
    const declaration = toolDeclaration(item.name);
    if (!declaration) throw new Error(`unknown toolkit tool: ${item.name}`);
    const path = join(binRoot, item.name);
    chmodSync(path, 0o755);
    tools.push(await resource(path, declaration));
  }
  const toolIds = new Set(tools.map((tool) => tool.id));
  const component = (role: string, resourceId: string) => ({
    role,
    kind: "tool",
    resourceId,
    resourceVersion: tools.find((tool) => tool.id === resourceId)!.version,
  });
  const bundles = [];
  if (toolIds.has("pydump-analyzer")) {
    bundles.push({
      id: "pydump-analysis",
      protocol: "pydump.analysis/v1",
      version: PYDUMP_ANALYSIS_VERSION,
      components: [component("analyzer", "pydump-analyzer")],
    });
  }
  if (toolIds.has("fork-pyheap-dumper")) {
    bundles.push({
      id: "pyheap-capture",
      protocol: "fork-pyheap.capture/v1",
      version: FORK_PYHEAP_VERSION,
      components: [component("dumper", "fork-pyheap-dumper")],
    });
  }
  for (const tool of tools) {
    const agent = /^pydump-agent-(3\.\d+)-min-glibc-(\d+(?:\.\d+)+)$/.exec(tool.id);
    if (!agent) continue;
    if (!toolIds.has("pydump-collector") || !toolIds.has("pydump-loader")) {
      throw new Error(`pydump Agent 缺少同平台 Collector 或 pydump-loader: ${entry.name}/${tool.id}`);
    }
    bundles.push({
      id: "pydump-capture",
      protocol: "pydump.capture/v1",
      version: PYDUMP_CAPTURE_VERSION,
      compatibility: {
        runtime: { name: "cpython", version: agent[1] },
        libc: { family: "glibc", minimumVersion: agent[2] },
      },
      components: [
        component("collector", "pydump-collector"),
        component("loader", "pydump-loader"),
        component("agent", tool.id),
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
    images: await listResources(join(platformRoot, "images"), (name) => {
      if (name !== "doctor-debug.tar") throw new Error(`unknown toolkit image: ${name}`);
      return { id: "doctor-debug", version, requirements: {} };
    }),
    packages: await listResources(join(platformRoot, "packages"), (name) => ({
      id: name,
      version,
      // Package-set variants carry their own execution requirements.
      requirements: {},
    })),
    bundles,
  });
}
platforms.sort((left, right) =>
  `${left.os}/${left.architecture}`.localeCompare(`${right.os}/${right.architecture}`));

const buildGroups = [];
try {
  for (const entry of readdirSync(join(stage, ".build-inputs"), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const group = JSON.parse(readFileSync(join(stage, ".build-inputs", entry.name), "utf8"));
    if (
      group?.schema !== "doctor.toolkit.build-group/v1"
      || typeof group.kind !== "string"
      || typeof group.key !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(group.key)
      || typeof group.platform?.os !== "string"
      || typeof group.platform?.architecture !== "string"
    ) throw new Error(`invalid Toolkit build input: ${entry.name}`);
    buildGroups.push(group);
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
buildGroups.sort((left, right) => JSON.stringify([
  left.kind,
  left.platform.os,
  left.platform.architecture,
]).localeCompare(JSON.stringify([
  right.kind,
  right.platform.os,
  right.platform.architecture,
])));
const buildGroupIds = buildGroups.map((group) =>
  `${group.kind}/${group.platform.os}/${group.platform.architecture}`);
if (new Set(buildGroupIds).size !== buildGroupIds.length) {
  throw new Error("duplicate Toolkit build input group");
}

writeFileSync(join(root, "manifest.json"), `${JSON.stringify({
  schema: "doctor.toolkit/v3",
  version,
  platforms,
}, null, 2)}\n`);
writeFileSync(join(root, "build-manifest.json"), `${JSON.stringify({
  schema: "doctor.toolkit.build/v1",
  version,
  groups: buildGroups,
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
