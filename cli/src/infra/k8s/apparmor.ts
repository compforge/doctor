import type { ExecResult, Executor } from "./executor";

const PROBE_TIMEOUT_MS = 15_000;

export interface AppArmorUnconfinedAdmissionInput {
  namespace: string;
  serviceAccountName: string;
  image: string;
}

export interface AppArmorUnconfinedAdmissionResult {
  status: "allowed" | "denied" | "unknown";
  reason?: string;
  result: ExecResult;
}

function detail(result: ExecResult): string {
  return result.stderr.trim().split("\n")[0]
    || result.stdout.trim().split("\n")[0]
    || `exit=${result.exitCode ?? "unknown"}`;
}

function failedResult(error: unknown, command: string[]): ExecResult {
  return {
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    durationMs: 0,
    timedOut: false,
    command,
  };
}

function unconfinedDenied(result: ExecResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return /apparmor/i.test(output)
    && /unconfined/i.test(output)
    && /(denied|forbidden|violates\s+podsecurity)/i.test(output);
}

/**
 * Ask the API Server whether the workload ServiceAccount may create an Unconfined Pod.
 * Server-side dry-run exercises RBAC and admission without persisting a Pod; failures that do
 * not explicitly identify AppArmor remain unknown so transport/impersonation errors cannot be
 * misreported as an AppArmor policy denial.
 */
export async function probeAppArmorUnconfinedAdmission(
  executor: Executor,
  input: AppArmorUnconfinedAdmissionInput,
): Promise<AppArmorUnconfinedAdmissionResult> {
  const identity = `system:serviceaccount:${input.namespace}:${input.serviceAccountName}`;
  const command = [
    "create",
    "-f",
    "-",
    "--dry-run=server",
    "-o",
    "json",
    "--as",
    identity,
  ];
  const manifest = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      generateName: "doctor-apparmor-unconfined-",
      namespace: input.namespace,
    },
    spec: {
      serviceAccountName: input.serviceAccountName,
      restartPolicy: "Never",
      containers: [{
        name: "doctor-probe",
        image: input.image,
        securityContext: {
          appArmorProfile: { type: "Unconfined" },
          allowPrivilegeEscalation: false,
          capabilities: { drop: ["ALL"] },
          runAsNonRoot: true,
          runAsUser: 65_532,
          seccompProfile: { type: "RuntimeDefault" },
        },
      }],
    },
  };
  let result: ExecResult;
  try {
    result = await executor.run(command, {
      stdin: JSON.stringify(manifest),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    result = failedResult(error, command);
  }
  if (result.ok) return { status: "allowed", result };
  return unconfinedDenied(result)
    ? { status: "denied", reason: detail(result), result }
    : { status: "unknown", reason: detail(result), result };
}
