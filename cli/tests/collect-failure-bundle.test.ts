import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceBundle } from "../src/collect/evidence";
import {
  deliverFailureBundle,
  resolveFailureBundlePath,
} from "../src/collect/output/failure-bundle";

describe("collect failure bundle delivery", () => {
  test("成功格式后缀统一替换为 tar.gz", () => {
    expect(resolveFailureBundlePath("report.html", "fallback")).toBe("report.tar.gz");
    expect(resolveFailureBundlePath("report.json", "fallback")).toBe("report.tar.gz");
    expect(resolveFailureBundlePath(undefined, "fallback")).toBe("fallback.tar.gz");
  });

  test("失败 Bundle 包含 error.log 与已记录步骤", async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-failure-bundle-test-"));
    const bundleName = "doctor-test-evidence";
    const staging = join(root, bundleName);
    mkdirSync(staging);
    const bundle = new EvidenceBundle(staging);
    bundle.addStep({
      id: "probe",
      title: "probe",
      risk: "observe",
      status: "failed",
      reason: "connection reset",
      stderr: "full error",
    });
    bundle.writeSummary("# failed");
    bundle.writeManifest({
      doctorVersion: "test",
      target: {},
      inspectionFacts: {},
      params: {},
      startedAt: "2026-07-20T00:00:00Z",
      finishedAt: "2026-07-20T00:00:01Z",
    });
    const delivery = await deliverFailureBundle({
      bundleDir: staging,
      bundleName,
      requestedOutput: join(root, "report.html"),
      collectCode: 1,
    });
    expect(delivery.packed.ok).toBe(true);
    expect(existsSync(delivery.path)).toBe(true);

    const extracted = join(root, "extracted");
    mkdirSync(extracted);
    const tar = Bun.spawnSync(["tar", "-xzf", delivery.path, "-C", extracted]);
    expect(tar.exitCode).toBe(0);
    const errorLog = readFileSync(join(extracted, bundleName, "error.log"), "utf-8");
    expect(errorLog).toContain("collect_exit_code=1");
    expect(errorLog).toContain("probe [failed]: connection reset");
    rmSync(root, { recursive: true, force: true });
  });
});
