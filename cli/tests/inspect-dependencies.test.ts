import { expect, test } from "bun:test";

import {
  parseDependencyPayload,
  parseGoDependencyOutput,
} from "../src/collect/inspect";

test("依赖采集输出归一化、去重并稳定排序", () => {
  expect(parseDependencyPayload(JSON.stringify({
    runtimeVersion: "3.12.4",
    dependencies: [
      { name: "urllib3", version: "2.2.2" },
      { name: "Pydantic", version: "2.8.2" },
      { name: "urllib3", version: "2.2.3" },
      { name: "", version: "ignored" },
    ],
  }))).toEqual({
    runtimeVersion: "3.12.4",
    dependencies: [
      { name: "Pydantic", version: "2.8.2" },
      { name: "urllib3", version: "2.2.3" },
    ],
    truncated: undefined,
  });
});

test("Go build info 转为统一依赖清单", () => {
  expect(parseGoDependencyOutput([
    "/proc/1/exe: go1.24.2",
    "mod\texample.test/service\t(devel)",
    "dep\tgithub.com/example/dependency\tv1.2.3\th1:sum",
    "build\tGOOS=linux",
  ].join("\n"))).toEqual({
    runtimeVersion: "go1.24.2",
    dependencies: [
      { name: "example.test/service", version: "(devel)" },
      { name: "github.com/example/dependency", version: "v1.2.3" },
    ],
  });
});
