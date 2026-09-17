import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import { CommandStatus, type CommandContext } from "../command";
import type { CommandArtifact } from "../command/artifacts";
import type { StepRecord } from "../collect/evidence";
import { terminalStderr, writeMachineResult } from "../terminal/output";
import { createBundleManifest, planBundleArtifacts, type BundleArtifact } from "./bundle-layout";
import { renderBundleAgents } from "./bundle-agents";
import { kubernetesTargetRecord } from "../command/kubernetes-target";

export interface ManifestResult {
  status: CommandStatus;
  reason?: string;
}

function evidenceIndex(entry: BundleArtifact) {
  const manifest = join(entry.artifact.path, "manifest.json");
  const diagnosis = join(entry.artifact.path, "diagnosis.json");
  const meta = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) as {
    target?: unknown; steps?: StepRecord[]; files?: Record<string, string>;
  } : undefined;
  return {
    manifest: meta ? posix.join(entry.path, "manifest.json") : undefined,
    diagnosis: existsSync(diagnosis) ? posix.join(entry.path, "diagnosis.json") : undefined,
    target: meta?.target,
    files: meta?.files && Object.fromEntries(Object.entries(meta.files).map(([name, path]) => [name, posix.join(entry.path, path)])),
    // Preserve the producer's reasons; do not infer completeness by parsing prose or raw logs.
    evidence_gaps: meta?.steps?.filter(step => ["partial", "failed", "skipped", "unavailable"].includes(step.status))
      .map(step => ({ id: step.id, status: step.status, reason: step.reason })),
    truncations: meta?.steps?.filter(step => step.truncation).map(step => ({ id: step.id, ...step.truncation })),
  };
}

function restrictPermissions(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("Evidence must not link outside its delivered directory");
  chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of readdirSync(path)) restrictPermissions(join(path, name));
}

/**
 * @spec Manifest delivery emits one JSON document and retains an uncompressed, private Bundle.
 * @rule Copy before publishing references. Failed delivery preserves source evidence and never overwrites output.
 */
export function deliverManifest(input: {
  command: string; code: number; result: ManifestResult; context?: CommandContext; output?: string;
}): { code: number; delivered: boolean } {
  const artifacts = input.context?.artifacts.list() ?? [];
  const retained: Array<CommandArtifact & { reason: string }> = [];
  const delivered: BundleArtifact[] = [];
  const errors: string[] = [];
  let root: string | undefined;
  try {
    if (input.output?.trim()) {
      root = resolve(input.output);
      if (artifacts.some(artifact => root === artifact.path || root!.startsWith(`${artifact.path}${sep}`))) {
        throw new Error("--output must not be inside a source artifact");
      }
      // Non-recursive mkdir refuses an existing directory, even when it is empty.
      mkdirSync(root, { mode: 0o700 });
    } else {
      root = mkdtempSync(join(tmpdir(), "doctor-manifest-"));
      chmodSync(root, 0o700);
    }
    for (const artifact of artifacts) {
      try {
        const entry = planBundleArtifacts([artifact])[0]!;
        const destination = join(root, entry.path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        cpSync(artifact.path, destination, { recursive: true, errorOnExist: true, force: false,
          filter: source => {
            if (lstatSync(source).isSymbolicLink()) throw new Error("Evidence contains a symbolic link");
            return true;
          },
        });
        restrictPermissions(destination);
        delivered.push({ ...entry, artifact: { ...artifact, path: destination } });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        retained.push({ ...artifact, reason });
        errors.push(`Artifact ${artifact.id}: ${reason}`);
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    errors.push(reason);
    retained.push(...artifacts.map(artifact => ({ ...artifact, reason })));
    root = undefined;
  }
  const indexed = delivered.map(entry => {
    try { return { id: entry.artifact.id, command: entry.artifact.command, path: entry.path, ...evidenceIndex(entry) }; }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`Artifact ${entry.artifact.id} metadata: ${reason}`);
      return { id: entry.artifact.id, command: entry.artifact.command, path: entry.path, metadata_error: reason };
    }
  });
  const manifest = {
    ...createBundleManifest(input.command, input.code, delivered, undefined, input.result),
    bundle_root: root,
    manifest: root ? "manifest.json" : undefined,
    execution: input.result,
    source: input.context ? {
      profile: input.context.profile.name,
      plugin: input.context.pluginIdentity,
      targets: input.context.records(kubernetesTargetRecord, []),
      kubernetes: input.context.inspection.kubernetes ? {
        kubeconfig: input.context.inspection.kubernetes.kubeconfig.kubeconfig,
        kubeconfig_source: input.context.inspection.kubernetes.kubeconfig.source,
        context: input.context.inspection.kubernetes.context,
      } : undefined,
    } : undefined,
    artifacts: indexed,
    retained_artifacts: retained,
    delivery: { status: errors.length ? "failed" : "ok", errors },
  };
  const updateOutcome = () => {
    manifest.exit_code = input.code === 130 ? 130 : errors.length ? 1 : input.code;
    manifest.status = input.result.status === CommandStatus.Cancelled ? CommandStatus.Cancelled
      : errors.length ? CommandStatus.Failed : input.result.status;
    manifest.delivery.status = errors.length ? "failed" : "ok";
  };
  updateOutcome();
  if (root) {
    try {
      writeFileSync(join(root, "AGENTS.md"), renderBundleAgents({ command: input.command, commandCode: manifest.exit_code, artifacts: delivered }), { mode: 0o600 });
      writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      manifest.manifest = undefined;
      updateOutcome();
    }
  }
  for (const error of errors) terminalStderr.error(`[delivery] ${error}\n`);
  // Deliberately bypass human-output routing; this is the sole machine-readable stdout document.
  writeMachineResult(manifest);
  return { code: manifest.exit_code, delivered: errors.length === 0 };
}
