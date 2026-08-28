import { expect, test } from "bun:test";
import { probeAppArmorUnconfinedAdmission } from "../src/infra/k8s/apparmor";
import type { ExecResult, Executor, RunOptions } from "../src/infra/k8s/executor";

function result(input: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command: ["kubectl"],
    ...input,
  };
}

const input = {
  namespace: "platform-system",
  serviceAccountName: "runtime-api",
  image: "registry.example/runtime-api:v1",
};

test("AppArmor Unconfined probe 以 workload ServiceAccount 做 server-side dry-run", async () => {
  const calls: Array<{ args: string[]; options?: RunOptions }> = [];
  const executor: Executor = {
    run: async (args, options) => {
      calls.push({ args, options });
      return result({ command: ["kubectl", ...args] });
    },
    exec: async () => result(),
  };

  const admission = await probeAppArmorUnconfinedAdmission(executor, input);

  expect(admission.status).toBe("allowed");
  expect(calls[0]!.args).toEqual([
    "create",
    "-f",
    "-",
    "--dry-run=server",
    "-o",
    "json",
    "--as",
    "system:serviceaccount:platform-system:runtime-api",
  ]);
  const manifest = JSON.parse(String(calls[0]!.options?.stdin));
  expect(manifest).toMatchObject({
    metadata: {
      namespace: "platform-system",
    },
    spec: {
      serviceAccountName: "runtime-api",
      containers: [{
        name: "doctor-probe",
        image: "registry.example/runtime-api:v1",
        securityContext: {
          appArmorProfile: { type: "Unconfined" },
        },
      }],
    },
  });
});

test("只有明确的 AppArmor Unconfined admission 拒绝才判为 denied", async () => {
  const executor = (stderr: string): Executor => ({
    run: async () => result({ ok: false, exitCode: 1, stderr }),
    exec: async () => result(),
  });
  const denied = await probeAppArmorUnconfinedAdmission(executor(
    'pods "probe" is forbidden: violates PodSecurity "baseline:latest": AppArmor profile type must not be Unconfined',
  ), input);
  const unknown = await probeAppArmorUnconfinedAdmission(executor(
    'serviceaccounts "doctor" is forbidden: cannot impersonate resource "serviceaccounts"',
  ), input);

  expect(denied.status).toBe("denied");
  expect(unknown.status).toBe("unknown");
});

test("executor 异常按 best effort 返回 unknown", async () => {
  const executor: Executor = {
    run: async () => { throw new Error("kubectl unavailable"); },
    exec: async () => result(),
  };

  expect(await probeAppArmorUnconfinedAdmission(executor, input)).toMatchObject({
    status: "unknown",
    reason: "kubectl unavailable",
  });
});
