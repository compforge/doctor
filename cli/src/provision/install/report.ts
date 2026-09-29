import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DebugGdbFact } from "../../infra/target/debug";
import {
  bundleMatches,
  packageBundleRequirements,
  type PackageBundle,
  type PackageTargetFact,
} from "../../infra/target/package-install";

export interface InstallCompatibilityReport {
  schema: "doctor.install-compatibility/v1";
  generatedAt: string;
  target: {
    namespace: string;
    pod: string;
    container: string;
    runtime: PackageTargetFact;
  };
  gdb: {
    before: DebugGdbFact;
    after?: DebugGdbFact;
  };
  packageBundles: Array<{
    file: string;
    compatible: boolean;
    selected: boolean;
    manifest: PackageBundle["manifest"];
  }>;
  result: {
    status: "ready" | "failed" | "cancelled";
    stage: string;
    reason: string;
  };
}

function cell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "unknown";
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function gdbSummary(gdb: DebugGdbFact): string {
  return [
    `version=${gdb.version ?? "unknown"}`,
    `available=${gdb.available}`,
    `pythonScripting=${gdb.pythonScripting}`,
    `inferiorCall=${gdb.inferiorCall}`,
    gdb.reason ? `reason=${gdb.reason}` : undefined,
  ].filter(Boolean).join(", ");
}

export function renderInstallCompatibilityMarkdown(
  report: InstallCompatibilityReport,
): string {
  const runtime = report.target.runtime;
  const searchTerms = [
    runtime.osPrettyName ?? [runtime.osId, runtime.osVersionId].filter(Boolean).join(" "),
    runtime.architecture,
    `kernel ${runtime.kernelVersion ?? "unknown"}`,
    runtime.libc?.raw,
    `Python ${runtime.python?.version ?? "unknown"}`,
    `GDB ${report.gdb.after?.version ?? report.gdb.before.version ?? "unknown"}`,
    report.gdb.after?.reason ?? report.gdb.before.reason,
  ].filter(Boolean).join(" ");
  const lines = [
    "# Doctor GDB Compatibility Report",
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Target: namespace/${report.target.namespace} pod/${report.target.pod} container/${report.target.container}`,
    `- Result: ${report.result.status} at \`${report.result.stage}\` — ${cell(report.result.reason)}`,
    "",
    "## Target runtime",
    "",
    "| Field | Value |",
    "|---|---|",
    `| OS | ${cell(runtime.osPrettyName ?? [runtime.osId, runtime.osVersionId].filter(Boolean).join(" "))} |`,
    `| Architecture | ${cell(runtime.architecture)} (${cell(runtime.kernelMachine)}) |`,
    `| Kernel release | ${cell(runtime.kernelVersion)} |`,
    `| Kernel build | ${cell(runtime.kernelBuild)} |`,
    `| libc | ${cell(runtime.libc?.raw)} |`,
    `| Python | ${cell([
      runtime.python?.implementation,
      runtime.python?.version,
      runtime.python?.executable,
    ].filter(Boolean).join(" "))} |`,
    `| Package manager | ${cell([runtime.manager.kind, runtime.manager.version].filter(Boolean).join(" "))} |`,
    `| CPU identity | ${cell([
      runtime.cpu?.vendor,
      runtime.cpu?.family ? `family=${runtime.cpu.family}` : undefined,
      runtime.cpu?.modelId ? `model=${runtime.cpu.modelId}` : undefined,
    ].filter(Boolean).join(" "))} |`,
    `| CPU model | ${cell(runtime.cpu?.model)} |`,
    `| CPU flags/features | ${cell(runtime.cpu?.flags?.join(" "))} |`,
    `| CapEff | ${cell(runtime.security?.capEff)} |`,
    `| NoNewPrivs | ${cell(runtime.security?.noNewPrivs)} |`,
    `| Seccomp | ${cell(runtime.security?.seccomp)} |`,
    `| Yama ptrace_scope | ${cell(runtime.security?.ptraceScope)} |`,
    "",
    "## GDB capability",
    "",
    `- Before: ${gdbSummary(report.gdb.before)}`,
    report.gdb.after ? `- After: ${gdbSummary(report.gdb.after)}` : "- After: not run",
    "",
    "## Package bundles",
    "",
  ];
  if (report.packageBundles.length === 0) {
    lines.push("No Doctor package bundle candidate was found.");
  } else {
    lines.push(
      "| File | Compatible | Selected | Bundle | Platform | GDB | Kernel range |",
      "|---|---|---|---|---|---|---|",
    );
    for (const bundle of report.packageBundles) {
      const kernel = packageBundleRequirements({
        path: bundle.file,
        manifest: bundle.manifest,
      })?.software?.kernel;
      lines.push(
        `| ${cell(bundle.file)} | ${bundle.compatible ? "yes" : "no"}`
        + ` | ${bundle.selected ? "yes" : "no"}`
        + ` | ${cell(bundle.manifest.bundleVersion)}`
        + ` | ${cell(`${bundle.manifest.osId}/${bundle.manifest.osVersionId}/${bundle.manifest.architecture}`)}`
        + ` | ${cell(bundle.manifest.packageVersions?.gdb)}`
        + ` | ${cell([
          kernel?.minInclusive ? `>=${kernel.minInclusive}` : undefined,
          kernel?.maxExclusive ? `<${kernel.maxExclusive}` : undefined,
        ].filter(Boolean).join(" ") || "unbounded")} |`,
      );
    }
  }
  lines.push(
    "",
    "## Search hint",
    "",
    "Use the exact attach-call error together with the runtime ABI and CPU/kernel facts:",
    "",
    `\`${searchTerms.replace(/`/g, "'")}\``,
    "",
  );
  return lines.join("\n");
}

export function writeInstallCompatibilityReport(report: InstallCompatibilityReport): string {
  const directory = mkdtempSync(join(tmpdir(), "doctor-install-"));
  writeFileSync(join(directory, "diagnosis.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(directory, "summary.md"), renderInstallCompatibilityMarkdown(report), { mode: 0o600 });
  return directory;
}

export function packageBundleReport(
  bundles: readonly PackageBundle[],
  target: PackageTargetFact,
  packages: readonly string[],
  selected?: PackageBundle,
): InstallCompatibilityReport["packageBundles"] {
  return bundles.map((bundle) => ({
    file: bundle.variant
      ? `${basename(bundle.path)}#${bundle.variant.id}`
      : basename(bundle.path),
    compatible: bundleMatches(bundle, target, packages),
    selected: bundle === selected,
    manifest: bundle.manifest,
  }));
}
