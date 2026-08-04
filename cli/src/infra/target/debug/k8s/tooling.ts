import type { ExecTarget, Executor } from "../../../k8s/executor";
import type { DebugGdbFact, DebugTargetImageKeepalive } from "../model";

const KEEPALIVE_SECONDS = "2147483647";
const GDB_PYTHON_READY_MARKER = "DOCTOR_GDB_PYTHON_OK";
const GDB_INFERIOR_CALL_READY_MARKER = "DOCTOR_GDB_INFERIOR_CALL_OK";

const SHELL_BOOTSTRAP_PROBE = String.raw`
sleep_path="$(command -v sleep 2>/dev/null || true)"
printf 'sleep=%s\n' "$sleep_path"
`;

const PYTHON_BOOTSTRAP_PROBE = String.raw`
import json
import sys

print(json.dumps({
    "executable": sys.executable,
}))
`;

const GDB_ATTACH_CALL_PROBE = String.raw`
python3 -c 'import ctypes, time; ctypes.CDLL(None).prctl(0x59616D61, -1, 0, 0, 0); time.sleep(30)' &
inferior_pid=$!
cleanup() {
  kill "$inferior_pid" 2>/dev/null || true
  wait "$inferior_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
gdb -q -nx -batch \
  -ex "attach $inferior_pid" \
  -ex 'python value = gdb.parse_and_eval("(int)getpid()"); print("${GDB_INFERIOR_CALL_READY_MARKER}=" + str(value))' \
  -ex detach
`;

function validExecutablePath(value: string): boolean {
  return value.startsWith("/") && /^\/[A-Za-z0-9_./+-]+$/.test(value);
}

async function probeShell(
  exec: Executor,
  target: ExecTarget,
): Promise<DebugTargetImageKeepalive | undefined> {
  const result = await exec.exec(target, ["/bin/sh", "-c", SHELL_BOOTSTRAP_PROBE], {
    timeoutMs: 10_000,
  });
  if (!result.ok) return undefined;
  const entries = new Map(
    result.stdout
      .split("\n")
      .map((line) => line.trim().split("=", 2))
      .filter((parts) => parts.length === 2)
      .map(([key, value]) => [key, value] as const),
  );
  const sleep = entries.get("sleep");
  if (!sleep || !validExecutablePath(sleep)) return undefined;
  return {
    command: [sleep, KEEPALIVE_SECONDS],
    description: sleep,
  };
}

async function probePython(
  exec: Executor,
  target: ExecTarget,
): Promise<DebugTargetImageKeepalive | undefined> {
  const result = await exec.exec(target, ["python3", "-c", PYTHON_BOOTSTRAP_PROBE], {
    timeoutMs: 10_000,
  });
  if (!result.ok) return undefined;
  try {
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as {
      executable?: unknown;
    };
    if (typeof parsed.executable !== "string" || !validExecutablePath(parsed.executable)) {
      return undefined;
    }
    return {
      command: [parsed.executable, "-c", `import time; time.sleep(${KEEPALIVE_SECONDS})`],
      description: parsed.executable,
    };
  } catch {
    return undefined;
  }
}

export async function resolveTargetImageKeepalive(
  exec: Executor,
  pod: string,
  container: string,
): Promise<DebugTargetImageKeepalive | undefined> {
  const target = { pod, container };
  return await probeShell(exec, target) ?? await probePython(exec, target);
}

export async function inspectDebugGdb(
  exec: Executor,
  pod: string,
  container: string,
): Promise<DebugGdbFact> {
  const target = { pod, container };
  const versionResult = await exec.exec(target, ["gdb", "--version"], { timeoutMs: 20_000 });
  if (!versionResult.ok) {
    return {
      available: false,
      pythonScripting: false,
      inferiorCall: false,
      reason: "未找到 gdb",
    };
  }
  const version = versionResult.stdout.match(/\b(\d+(?:\.\d+)+)\b/)?.[1];
  const python = await exec.exec(
    target,
    [
      "gdb",
      "-nx",
      "-batch",
      "-ex",
      `python import sys; print("${GDB_PYTHON_READY_MARKER}")`,
      "-ex",
      "quit",
    ],
    { timeoutMs: 20_000 },
  );
  if (!python.ok || !python.stdout.includes(GDB_PYTHON_READY_MARKER)) {
    return {
      available: true,
      pythonScripting: false,
      inferiorCall: false,
      version,
      reason: "gdb 不支持 Python scripting",
    };
  }
  const inferiorCall = await exec.exec(
    target,
    ["sh", "-c", GDB_ATTACH_CALL_PROBE],
    { timeoutMs: 30_000 },
  );
  if (
    !inferiorCall.ok
    || !inferiorCall.stdout.includes(GDB_INFERIOR_CALL_READY_MARKER)
  ) {
    const lines = `${inferiorCall.stderr}\n${inferiorCall.stdout}`
      .split("\n")
      .map((line) => line.trim());
    const error = lines
      .find((line) => line.includes("gdb.error:"))
      ?.split("gdb.error:", 2)[1]
      ?.trim()
      ?? lines
      .reverse()
      .find((line) => line && !line.toLowerCase().startsWith("warning:"));
    return {
      available: true,
      pythonScripting: true,
      inferiorCall: false,
      version,
      reason: `gdb 无法调用调试进程函数${error ? `：${error}` : ""}`,
    };
  }
  return {
    available: true,
    pythonScripting: true,
    inferiorCall: true,
    version,
  };
}
