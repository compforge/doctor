import type { ExecResult, ExecTarget, Executor } from "../../k8s/executor";
import type {
  PackageInstaller,
  PackageManager,
  PackageManagerKind,
  PackageTargetFact,
  TargetCpuFact,
  TargetLibcFact,
  TargetPythonFact,
  TargetSecurityFact,
} from "./model";
import {
  requiredTargetProbes,
  type TargetRequirements,
} from "../requirements";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MANAGERS: Array<{ kind: PackageManagerKind; paths: string[] }> = [
  { kind: "apt-get", paths: ["/usr/bin/apt-get", "/bin/apt-get"] },
  { kind: "apk", paths: ["/sbin/apk", "/usr/sbin/apk"] },
  { kind: "dnf", paths: ["/usr/bin/dnf", "/bin/dnf"] },
  { kind: "microdnf", paths: ["/usr/bin/microdnf", "/bin/microdnf"] },
  { kind: "yum", paths: ["/usr/bin/yum", "/bin/yum"] },
];

async function detectManager(
  executor: Executor,
  target: ExecTarget,
): Promise<PackageManager | undefined> {
  for (const manager of MANAGERS) {
    for (const path of manager.paths) {
      const result = await executor.exec(target, [path, "--version"], { timeoutMs: 10_000 });
      if (result.ok) {
        return {
          kind: manager.kind,
          path,
          version: result.stdout.split("\n").find((line) => line.trim())?.trim(),
        };
      }
    }
  }
  return undefined;
}

async function readOsRelease(
  executor: Executor,
  target: ExecTarget,
): Promise<{ id?: string; versionId?: string; prettyName?: string }> {
  const result = await executor.exec(target, ["/bin/cat", "/etc/os-release"], {
    timeoutMs: 10_000,
  });
  if (!result.ok) return {};
  const values = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values.set(match[1]!, match[2]!.replace(/^["']|["']$/g, ""));
  }
  return {
    id: values.get("ID"),
    versionId: values.get("VERSION_ID"),
    prettyName: values.get("PRETTY_NAME"),
  };
}

async function inspectArchitecture(
  executor: Executor,
  target: ExecTarget,
  manager: PackageManager,
): Promise<string | undefined> {
  const command = manager.kind === "apt-get"
    ? ["/usr/bin/dpkg", "--print-architecture"]
    : manager.kind === "apk"
      ? [manager.path, "--print-arch"]
      : ["/bin/rpm", "--eval", "%{_arch}"];
  const result = await executor.exec(target, command, { timeoutMs: 10_000 });
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

async function inspectKernelVersion(
  executor: Executor,
  target: ExecTarget,
): Promise<string | undefined> {
  for (const path of ["/bin/uname", "/usr/bin/uname"]) {
    const result = await executor.exec(target, [path, "-r"], { timeoutMs: 10_000 });
    if (result.ok) return result.stdout.trim() || undefined;
  }
  return undefined;
}

async function inspectCommandValue(
  executor: Executor,
  target: ExecTarget,
  command: string[],
): Promise<string | undefined> {
  const result = await executor.exec(target, command, { timeoutMs: 10_000 });
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

async function inspectLibc(
  executor: Executor,
  target: ExecTarget,
): Promise<TargetLibcFact | undefined> {
  const raw = await inspectCommandValue(executor, target, ["getconf", "GNU_LIBC_VERSION"])
    ?? await inspectCommandValue(executor, target, ["ldd", "--version"]);
  if (!raw) return undefined;
  const firstLine = raw.split("\n")[0]?.trim();
  const glibc = /\bglibc\s+([0-9][^\s]*)/i.exec(firstLine ?? "");
  const trailingVersion = /\b([0-9]+(?:\.[0-9]+)+)\s*$/.exec(firstLine ?? "");
  return {
    family: glibc ? "glibc" : firstLine?.split(/\s+/)[0],
    version: glibc?.[1] ?? trailingVersion?.[1],
    raw: firstLine,
  };
}

async function inspectPython(
  executor: Executor,
  target: ExecTarget,
): Promise<TargetPythonFact | undefined> {
  const result = await executor.exec(target, [
    "python3",
    "-c",
    "import json,platform,sys; print(json.dumps({'executable':sys.executable,'implementation':platform.python_implementation(),'version':platform.python_version()}))",
  ], { timeoutMs: 10_000 });
  if (!result.ok) return undefined;
  try {
    return JSON.parse(result.stdout.trim()) as TargetPythonFact;
  } catch {
    return undefined;
  }
}

async function inspectCpu(
  executor: Executor,
  target: ExecTarget,
): Promise<TargetCpuFact | undefined> {
  const raw = await inspectCommandValue(executor, target, [
    "/bin/sh",
    "-c",
    "if command -v lscpu >/dev/null 2>&1; then lscpu; else head -c 65536 /proc/cpuinfo; fi",
  ]);
  if (!raw) return undefined;
  const values = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const match = /^([^:]+)\s*:\s*(.*)$/.exec(line);
    if (!match || values.has(match[1]!.trim().toLowerCase())) continue;
    values.set(match[1]!.trim().toLowerCase(), match[2]!.trim());
  }
  const flags = values.get("flags") ?? values.get("features");
  return {
    vendor: values.get("vendor id") ?? values.get("cpu implementer"),
    family: values.get("cpu family") ?? values.get("cpu architecture"),
    modelId: values.get("model"),
    model: values.get("model name")
      ?? values.get("model")
      ?? values.get("hardware")
      ?? values.get("processor"),
    flags: flags?.split(/\s+/).filter(Boolean),
  };
}

async function inspectSecurity(
  executor: Executor,
  target: ExecTarget,
): Promise<TargetSecurityFact | undefined> {
  const [status, ptraceScope] = await Promise.all([
    inspectCommandValue(executor, target, ["/bin/cat", "/proc/self/status"]),
    inspectCommandValue(executor, target, ["/bin/cat", "/proc/sys/kernel/yama/ptrace_scope"]),
  ]);
  if (!status && !ptraceScope) return undefined;
  const values = new Map<string, string>();
  for (const line of status?.split("\n") ?? []) {
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.trim());
  }
  return {
    capEff: values.get("CapEff"),
    noNewPrivs: values.get("NoNewPrivs"),
    ptraceScope,
    seccomp: values.get("Seccomp"),
  };
}

async function commandAvailable(
  executor: Executor,
  target: ExecTarget,
  command: string[],
): Promise<boolean> {
  return (await executor.exec(target, command, { timeoutMs: 10_000 })).ok;
}

async function inspectTarget(
  executor: Executor,
  pod: string,
  container: string,
  requirements: readonly (TargetRequirements | undefined)[] = [],
  options: { transfer?: boolean; diagnostics?: boolean } = {},
): Promise<PackageTargetFact | undefined> {
  const target = { pod, container };
  const manager = await detectManager(executor, target);
  if (!manager) return undefined;
  const probes = requiredTargetProbes(requirements);
  const [os, architecture] = await Promise.all([
    readOsRelease(executor, target),
    inspectArchitecture(executor, target, manager),
  ]);
  const needsLibc = probes.libraries.includes("libc");
  const [kernelVersion, kernelMachine, kernelBuild, libc, python, cpu, security, tarAvailable] =
    await Promise.all([
      probes.kernel || options.diagnostics ? inspectKernelVersion(executor, target) : undefined,
      options.diagnostics ? inspectCommandValue(executor, target, ["uname", "-m"]) : undefined,
      options.diagnostics ? inspectCommandValue(executor, target, ["uname", "-v"]) : undefined,
      needsLibc || options.diagnostics ? inspectLibc(executor, target) : undefined,
      options.transfer || options.diagnostics ? inspectPython(executor, target) : undefined,
      probes.cpu || options.diagnostics ? inspectCpu(executor, target) : undefined,
      options.diagnostics ? inspectSecurity(executor, target) : undefined,
      options.transfer
        ? commandAvailable(executor, target, ["/bin/tar", "--version"])
        : false,
    ]);
  return {
    manager,
    osId: os.id,
    osVersionId: os.versionId,
    osPrettyName: os.prettyName,
    architecture,
    kernelVersion,
    kernelMachine,
    kernelBuild,
    libc,
    libraries: libc ? { libc } : undefined,
    python,
    cpu,
    security,
    pythonAvailable: Boolean(python),
    tarAvailable,
  };
}

async function packagesInstalled(
  executor: Executor,
  pod: string,
  container: string,
  target: PackageTargetFact,
  packages: readonly string[],
): Promise<boolean> {
  const execTarget = { pod, container };
  for (const name of packages) {
    const command = target.manager.kind === "apt-get"
      ? ["/usr/bin/dpkg-query", "-W", "-f=${Status}", name]
      : target.manager.kind === "apk"
        ? [target.manager.path, "info", "-e", name]
        : ["/bin/rpm", "-q", name];
    const result = await executor.exec(execTarget, command, { timeoutMs: 10_000 });
    if (!result.ok || (target.manager.kind === "apt-get" && !result.stdout.includes("install ok installed"))) {
      return false;
    }
  }
  return true;
}

export function onlineInstallCommands(
  target: PackageTargetFact,
  packages: readonly string[],
): string[][] {
  if (target.manager.kind === "apt-get") {
    return [
      [target.manager.path, "update"],
      [
        "/usr/bin/env",
        "DEBIAN_FRONTEND=noninteractive",
        target.manager.path,
        "install",
        "-y",
        "--no-install-recommends",
        ...packages,
      ],
    ];
  }
  if (target.manager.kind === "apk") {
    return [[target.manager.path, "add", "--no-cache", ...packages]];
  }
  return [[target.manager.path, "install", "-y", ...packages]];
}

async function installOnline(
  executor: Executor,
  pod: string,
  container: string,
  target: PackageTargetFact,
  packages: readonly string[],
): Promise<ExecResult> {
  const execTarget = { pod, container };
  let result: ExecResult | undefined;
  for (const command of onlineInstallCommands(target, packages)) {
    result = await executor.exec(execTarget, command, { timeoutMs: INSTALL_TIMEOUT_MS });
    if (!result.ok) return result;
  }
  return result!;
}

const INSTALL_APT_BUNDLE_SCRIPT = String.raw`
set -eu
bundle="$1"
work="$2"
apt_get="$3"
shift 3
export DEBIAN_FRONTEND=noninteractive
rm -rf "$work"
mkdir -p "$work" "$work/empty-parts" "$work/lists/partial"
trap 'rm -rf "$work"' EXIT
/bin/tar -xf "$bundle" -C "$work"
printf 'deb [trusted=yes] file:%s/doctor-packages/repo ./\n' "$work" > "$work/sources.list"
apt_opts="-o Dir::Etc::SourceList=$work/sources.list -o Dir::Etc::SourceParts=$work/empty-parts -o Dir::State::Lists=$work/lists"
"$apt_get" $apt_opts update
"$apt_get" $apt_opts install -y --allow-downgrades --no-install-recommends "$@"
`;

async function installBundle(
  executor: Executor,
  pod: string,
  container: string,
  target: PackageTargetFact,
  packages: readonly string[],
  remoteTarPath: string,
): Promise<ExecResult> {
  const work = `/tmp/doctor-install-${Date.now().toString(36)}`;
  return executor.exec(
    { pod, container },
    [
      "/bin/sh",
      "-c",
      INSTALL_APT_BUNDLE_SCRIPT,
      "doctor-install",
      remoteTarPath,
      work,
      target.manager.path,
      ...packages,
    ],
    { timeoutMs: INSTALL_TIMEOUT_MS },
  );
}

export const kubernetesPackageInstaller: PackageInstaller = {
  inspect: inspectTarget,
  installed: packagesInstalled,
  installOnline,
  installBundle,
};
