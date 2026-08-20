import { expect, test } from "bun:test";
import { getDoctorHostInfo } from "../src/infra/host";

test("Doctor Host 信息可被命令复用", () => {
  const facts = getDoctorHostInfo();
  expect(facts.platform).toBe(process.platform);
  expect(facts.architecture).toBe(process.arch);
  expect(facts.kernelRelease.length).toBeGreaterThan(0);
  if (facts.glibcVersion !== undefined) expect(facts.glibcVersion.length).toBeGreaterThan(0);
  expect(facts.cpu.logicalCount).toBeGreaterThan(0);
  expect(facts.totalMemoryBytes).toBeGreaterThan(0);
  expect(facts.runtime.version.length).toBeGreaterThan(0);
});
