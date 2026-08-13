import { expect, test } from "bun:test";
import {
  findLocalDoctorDebugImages,
  localContainerPydumpAnalyzerArgv,
} from "../src/collect/memory/local-container-analyzer";
import type {
  LocalCommandResult,
  LocalContainerEngine,
} from "../src/infra/host/container-engine";

function result(stdout: string): LocalCommandResult {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
  };
}

test("Pydump 适配按 debug image 版本排序，分析容器禁网并只读挂载单个 heap", async () => {
  const engine: LocalContainerEngine = {
    name: "nerdctl",
    run: async () => result(
      "doctor-debug:old-linux-amd64\ndoctor-debug:current-linux-amd64\n",
    ),
  };
  expect(await findLocalDoctorDebugImages(engine, "current")).toEqual([
    "doctor-debug:current-linux-amd64",
    "doctor-debug:old-linux-amd64",
  ]);

  const argv = localContainerPydumpAnalyzerArgv(
    engine,
    "doctor-debug:current-linux-amd64",
    "/tmp/captures/app.pyheap",
  );
  expect(argv.slice(0, 5)).toEqual(["nerdctl", "run", "--rm", "--network", "none"]);
  expect(argv).toContain("/tmp/captures/app.pyheap:/doctor-input/input.pyheap:ro");
  expect(argv).toContain("/doctor-input/input.pyheap");
  expect(argv).toContain("/opt/doctor/bin/pydump_analyzer");
});
