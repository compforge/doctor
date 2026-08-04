import { expect, test } from "bun:test";
import { inspectDoctorHost } from "../src/command";

test("Doctor Host Inspect 返回命令可复用的稳定平台 Facts", async () => {
  const facts = await inspectDoctorHost();

  expect(facts.platform).toBe(process.platform);
  expect(facts.architecture).toBe(process.arch);
  expect(facts.kernelRelease.length).toBeGreaterThan(0);
  expect(facts.cpu.logicalCount).toBeGreaterThan(0);
  expect(facts.totalMemoryBytes).toBeGreaterThan(0);
  expect(facts.runtime.version.length).toBeGreaterThan(0);
});
