import { expect, test } from "bun:test";
import {
  discoverLocalContainerEngine,
  listLocalImagesByLabel,
  prepareLocalImage,
  type LocalCommandResult,
  type LocalContainerEngine,
} from "../src/infra/host/container-engine";
import { resolveHostExecution } from "../src/infra/host/execution";

function result(ok: boolean, stdout = "", stderr = ""): LocalCommandResult {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    stdout,
    stderr,
    timedOut: false,
  };
}

test("本地 container engine 按 Docker、Podman、nerdctl 顺序探测并隐藏 CLI 差异", async () => {
  const commands: string[][] = [];
  const engine = await discoverLocalContainerEngine(async (argv) => {
    commands.push([...argv]);
    return result(argv[0] === "podman");
  });
  expect(engine?.name).toBe("podman");
  expect(commands).toEqual([
    ["docker", "info"],
    ["podman", "info"],
  ]);

  await engine?.run(["image", "inspect", "doctor-debug:1"]);
  expect(commands.at(-1)).toEqual([
    "podman",
    "image",
    "inspect",
    "doctor-debug:1",
  ]);
});

test("Host 执行优先使用已可用 container，不能使用时回退本机进程", async () => {
  const engine: LocalContainerEngine = {
    name: "docker",
    run: async () => result(true),
  };
  const order: string[] = [];
  const container = await resolveHostExecution({
    discoverContainerEngine: async () => engine,
    container: async () => {
      order.push("container");
      return "ready";
    },
    process: async () => {
      order.push("process");
      return "fallback";
    },
  });
  expect(container.kind).toBe("host-container");
  expect(order).toEqual(["container"]);

  order.length = 0;
  const process = await resolveHostExecution({
    discoverContainerEngine: async () => engine,
    container: async () => {
      order.push("container");
      return undefined;
    },
    process: async () => {
      order.push("process");
      return "fallback";
    },
  });
  expect(process).toEqual({ kind: "host-process", value: "fallback" });
  expect(order).toEqual(["container", "process"]);
});

test("本地 image 准备只在 image 缺失时执行 load 并再次确认", async () => {
  const commands: string[][] = [];
  const engine: LocalContainerEngine = {
    name: "docker",
    run: async (argv) => {
      commands.push([...argv]);
      if (argv[0] === "load") return result(true, "Loaded image: doctor-debug:1");
      return result(commands.length === 3);
    },
  };
  expect(await prepareLocalImage(engine, "/tmp/doctor-debug.tar", "doctor-debug:1"))
    .toEqual({ state: "loaded", engine: "docker", image: "doctor-debug:1" });
  expect(commands).toEqual([
    ["image", "inspect", "doctor-debug:1"],
    ["load", "-i", "/tmp/doctor-debug.tar"],
    ["image", "inspect", "doctor-debug:1"],
  ]);
});

test("本地 image 按 label 查询并过滤无 tag 的结果", async () => {
  const engine: LocalContainerEngine = {
    name: "nerdctl",
    run: async () => result(
      true,
      "tool:old\n<none>:<none>\ntool:current\ntool:old\n",
    ),
  };
  expect(await listLocalImagesByLabel(engine, "org.example.tool=doctor")).toEqual([
    "tool:current",
    "tool:old",
  ]);
});
