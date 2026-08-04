import { expect, test } from "bun:test";
import {
  inspectDebugGdb,
  resolveTargetImageKeepalive,
} from "../src/infra/target/debug/k8s/tooling";
import type {
  ExecResult,
  Executor,
} from "../src/infra/k8s/executor";

function result(stdout = "", ok = true): ExecResult {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    stdout,
    stderr: ok ? "" : "failed",
    durationMs: 1,
    timedOut: false,
    command: ["kubectl"],
  };
}

test("目标业务镜像优先使用安全 sleep", async () => {
  const executor: Executor = {
    run: async () => result(),
    exec: async (_target, command) => {
      expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
      return result("sleep=/bin/sleep\n");
    },
  };
  expect(await resolveTargetImageKeepalive(executor, "app-0", "app")).toEqual({
    command: ["/bin/sleep", "2147483647"],
    description: "/bin/sleep",
  });
});

test("没有 shell/sleep 时使用目标镜像 Python 常驻，不运行业务 entrypoint", async () => {
  let calls = 0;
  const executor: Executor = {
    run: async () => result(),
    exec: async (_target, command) => {
      calls += 1;
      if (command[0] === "/bin/sh") return result("", false);
      return result('{"executable":"/usr/local/bin/python3"}\n');
    },
  };
  const bootstrap = await resolveTargetImageKeepalive(executor, "app-0", "app");
  expect(calls).toBe(2);
  expect(bootstrap).toMatchObject({
    command: [
      "/usr/local/bin/python3",
      "-c",
      "import time; time.sleep(2147483647)",
    ],
  });
});

test("GDB 探测区分缺失与缺少 Python scripting", async () => {
  let calls = 0;
  const executor: Executor = {
    run: async () => result(),
    exec: async () => {
      calls += 1;
      return calls === 1 ? result("GNU gdb 15.1") : result("", false);
    },
  };
  expect(await inspectDebugGdb(executor, "app-0", "debug")).toEqual({
    available: true,
    pythonScripting: false,
    inferiorCall: false,
    version: "15.1",
    reason: "gdb 不支持 Python scripting",
  });
});

test("GDB readiness 同时验证 Python scripting 和 inferior call", async () => {
  let attachProbe = "";
  const executor: Executor = {
    run: async () => result(),
    exec: async (_target, command) => {
      if (command.includes("--version")) return result("GNU gdb 16.3\n");
      if (command.some((part) => part.includes("DOCTOR_GDB_PYTHON_OK"))) {
        return result("DOCTOR_GDB_PYTHON_OK\n");
      }
      attachProbe = command.at(-1) ?? "";
      return result("DOCTOR_GDB_INFERIOR_CALL_OK\n");
    },
  };
  expect(await inspectDebugGdb(executor, "app-0", "debug")).toEqual({
    available: true,
    pythonScripting: true,
    inferiorCall: true,
    version: "16.3",
  });
  expect(attachProbe).toContain("attach $inferior_pid");
  expect(attachProbe).toContain("gdb.parse_and_eval");
  expect(attachProbe).not.toContain("-ex \"start\"");
});

test("GDB attach inferior call 失败时保留真实错误", async () => {
  const executor: Executor = {
    run: async () => result(),
    exec: async (_target, command) => {
      if (command.includes("--version")) return result("GNU gdb 13.1\n");
      if (command.some((part) => part.includes("DOCTOR_GDB_PYTHON_OK"))) {
        return result("DOCTOR_GDB_PYTHON_OK\n");
      }
      return {
        ...result([
          "Traceback (most recent call last):",
          "gdb.error: Couldn't write extended state status: Bad address.",
        ].join("\n"), false),
        stderr: "",
      };
    },
  };
  expect(await inspectDebugGdb(executor, "app-0", "debug")).toEqual({
    available: true,
    pythonScripting: true,
    inferiorCall: false,
    version: "13.1",
    reason: "gdb 无法调用调试进程函数：Couldn't write extended state status: Bad address.",
  });
});
