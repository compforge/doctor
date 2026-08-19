import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceBundle, OUTCOME_UNREACHED_REASON, truncateRaw } from "../src/collect/evidence";
import {
  packBundle,
  packReportBundle,
  resolveDefaultReportPaths,
} from "../src/collect/output/archive";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "doctor-evidence-"));
}

describe("EvidenceBundle", () => {
  test("writes raw file per step with sequence prefix", () => {
    const dir = tmp();
    const bundle = new EvidenceBundle(dir);
    bundle.addStep({ id: "a", title: "A", risk: "observe", status: "ok", output: "hello" });
    bundle.addStep({ id: "b", title: "B", risk: "observe", status: "failed", reason: "boom", output: "", stderr: "err!" });
    bundle.addStep({ id: "c", title: "C", risk: "observe", status: "skipped", reason: "not requested" });

    expect(readFileSync(join(dir, "raw", "01-a.txt"), "utf-8")).toBe("hello");
    // stderr 非空时并入 raw，带分隔标记
    expect(readFileSync(join(dir, "raw", "02-b.txt"), "utf-8")).toContain("----- stderr -----");
    // 无输出的步骤不产生 raw 文件
    expect(existsSync(join(dir, "raw", "03-c.txt"))).toBe(false);
  });

  test("adopts an existing raw file without truncation", () => {
    const dir = tmp();
    const source = join(dir, ".capture.log");
    const raw = "x".repeat(600 * 1024);
    writeFileSync(source, raw);
    const bundle = new EvidenceBundle(dir);
    bundle.addStep({
      id: "logs-pod",
      title: "Pod logs",
      risk: "observe",
      status: "ok",
      rawFilePath: source,
      ext: "log",
    });
    expect(readFileSync(join(dir, "raw", "01-logs-pod.log"), "utf-8")).toBe(raw);
    expect(existsSync(source)).toBe(false);
  });

  test("manifest carries steps + meta", () => {
    const dir = tmp();
    const bundle = new EvidenceBundle(dir);
    bundle.addStep({
      id: "a",
      title: "A",
      risk: "observe",
      status: "ok",
      command: ["kubectl", "-n", "ns", "get", "pod"],
      exitCode: 0,
      durationMs: 12,
      output: "x",
    });
    bundle.writeManifest({
      doctorVersion: "0.0.1",
      kubectlVersion: "Client Version: v1.29.0",
      target: { namespace: "ns", pod: "p" },
      inspectionFacts: { canExec: true },
      params: { interval_sec: 60 },
      startedAt: "2026-07-10T00:00:00Z",
      finishedAt: "2026-07-10T00:01:00Z",
    });
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
    expect(manifest.doctor_version).toBe("0.0.1");
    expect(manifest.target.pod).toBe("p");
    expect(manifest.inspection_facts).toEqual({ canExec: true });
    expect(manifest.steps).toHaveLength(1);
    expect(manifest.steps[0]).toMatchObject({
      id: "a",
      status: "ok",
      raw_file: "raw/01-a.txt",
      command: ["kubectl", "-n", "ns", "get", "pod"],
    });
  });

  test("summary written with trailing newline", () => {
    const dir = tmp();
    const bundle = new EvidenceBundle(dir);
    bundle.writeSummary("# hi");
    expect(readFileSync(join(dir, "summary.md"), "utf-8")).toBe("# hi\n");
  });
});

describe("packBundle", () => {
  test("packs bundle dir into tar.gz with top-level dir preserved", async () => {
    const parent = tmp();
    const dir = join(parent, "doctor-mem-p-1");
    const bundle = new EvidenceBundle(dir);
    bundle.addStep({ id: "a", title: "A", risk: "observe", status: "ok", output: "hello" });
    bundle.writeSummary("# hi");

    const archive = join(parent, "case.tar.gz");
    const res = await packBundle(dir, archive);
    expect(res.ok).toBe(true);
    expect(existsSync(archive)).toBe(true);

    const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
    expect(listing).toContain("doctor-mem-p-1/summary.md");
    expect(listing).toContain("doctor-mem-p-1/raw/01-a.txt");
  });

  test("default delivery derives sibling HTML and tar.gz paths", () => {
    expect(resolveDefaultReportPaths(undefined, "doctor-data-1")).toEqual({
      html: "doctor-data-1.html",
      bundle: "doctor-data-1.tar.gz",
    });
    expect(resolveDefaultReportPaths("out/report.html", "ignored")).toEqual({
      html: "out/report.html",
      bundle: "out/report.tar.gz",
    });
  });

  test("successful report bundle requires root report.html", async () => {
    const parent = tmp();
    const dir = join(parent, "doctor-report");
    const bundle = new EvidenceBundle(dir);
    bundle.writeSummary("# hi");
    const missing = await packReportBundle(dir, join(parent, "missing.tar.gz"));
    expect(missing.ok).toBe(false);

    writeFileSync(join(dir, "report.html"), "<html>report</html>");
    const archive = join(parent, "report.tar.gz");
    expect((await packReportBundle(dir, archive)).ok).toBe(true);
    expect(Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString())
      .toContain("doctor-report/report.html");
  });
});

describe("truncateRaw", () => {
  test("under cap unchanged", () => {
    expect(truncateRaw("short", 100, 10)).toBe("short");
  });

  test("over cap keeps head and tail with marker", () => {
    const text = `HEAD${"x".repeat(1000)}TAIL`;
    const out = truncateRaw(text, 200, 50);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(text.length);
  });
});

/**
 * Worksheet 机制本身的契约。上一轮只在 collectMemory 那边端到端验证过，机制层是空的——
 * 而 trace / redis 复用的正是这一层。
 */
describe("EvidenceBundle worksheet", () => {
  const OUTCOMES = [
    { id: "probe", title: "探针", risk: "observe" as const },
    { id: "verdict", title: "判读", risk: "overhead" as const },
  ];
  const META = {
    doctorVersion: "test",
    target: {},
    inspectionFacts: {},
    params: {},
    startedAt: "2026-07-14T00:00:00Z",
    finishedAt: "2026-07-14T00:00:01Z",
  };

  test("不传 outcomes 时退化为纯追加，行为与以前一致", () => {
    const dir = tmp();
    const bundle = new EvidenceBundle(dir);
    bundle.addStep({ id: "a", title: "A", risk: "observe", status: "ok" });
    bundle.writeManifest(META);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
    expect(manifest.inspection_facts).toEqual({});
    expect(manifest.steps.map((s: any) => s.id)).toEqual(["a"]);
  });

  test("title/risk 来自声明，调用方不必也不能重复给", () => {
    const dir = tmp();
    const bundle = new EvidenceBundle(dir, OUTCOMES);
    bundle.fill("verdict", { status: "ok", output: "done" });
    expect(bundle.getSteps()[0]).toMatchObject({ id: "verdict", title: "判读", risk: "overhead", status: "ok" });
  });

  test("Outcome 可记录 unnecessary，但工序仍使用 skipped", () => {
    const bundle = new EvidenceBundle(tmp(), OUTCOMES);
    bundle.fill("probe", { status: "unnecessary", reason: "上游证据已经充分" });
    bundle.addStep({ id: "approval", title: "授权", risk: "observe", status: "skipped", reason: "无需申请" });
    expect(bundle.getSteps()).toEqual([
      expect.objectContaining({ id: "probe", status: "unnecessary" }),
      expect.objectContaining({ id: "approval", status: "skipped" }),
    ]);
  });

  test("Outcome 可记录 partial 并保留缺失原因", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-evidence-test-"));
    const bundle = new EvidenceBundle(dir, [{ id: "sample", title: "sample", risk: "observe" }]);
    bundle.fill("sample", { status: "partial", reason: "达到采集预算" });
    expect(bundle.getSteps()).toEqual([expect.objectContaining({
      id: "sample",
      status: "partial",
      reason: "达到采集预算",
    })]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("填格按执行顺序进 steps，不按声明顺序——manifest 仍是一条时间线", () => {
    const dir = tmp();
    const bundle = new EvidenceBundle(dir, OUTCOMES);
    bundle.fill("verdict", { status: "ok" });
    bundle.addStep({ id: "工序", title: "中间步骤", risk: "observe", status: "ok" });
    bundle.fill("probe", { status: "ok" });
    expect(bundle.getSteps().map((s) => s.id)).toEqual(["verdict", "工序", "probe"]);
  });

  test("一格只填一次：重复填 throw", () => {
    const bundle = new EvidenceBundle(tmp(), OUTCOMES);
    bundle.fill("probe", { status: "ok" });
    expect(() => bundle.fill("probe", { status: "failed", reason: "x" }))
      .toThrow("被填了两次");
  });

  test("填未声明的格子 throw——挡住 id 拼错", () => {
    const bundle = new EvidenceBundle(tmp(), OUTCOMES);
    expect(() => bundle.fill("prboe", { status: "ok" })).toThrow("未声明");
  });

  test("settle 已填过的格子不会覆盖，也不重复记账", () => {
    const bundle = new EvidenceBundle(tmp(), OUTCOMES);
    bundle.fill("probe", { status: "ok" });
    bundle.settle("没戏了");
    const ids = bundle.getSteps().map((s) => s.id);
    expect(ids).toEqual(["probe", "verdict"]);
    expect(bundle.getSteps()[0]).toMatchObject({ id: "probe", status: "ok" });
    expect(bundle.getSteps()[1]).toMatchObject({ id: "verdict", status: "unavailable", reason: "没戏了" });
  });

  test("settle 可只判部分项死刑——前置不同的项不该被牵连", () => {
    const bundle = new EvidenceBundle(tmp(), OUTCOMES);
    bundle.settle("探针跑不了", ["probe"]);
    expect(bundle.getSteps().map((s) => s.id)).toEqual(["probe"]);
    // verdict 还空着，留给后续或收尾兜底
    bundle.fill("verdict", { status: "ok" });
    expect(bundle.getSteps()[1]).toMatchObject({ id: "verdict", status: "ok" });
  });

  test("writeManifest 自动收尾：漏填的格子落 unavailable，不用调用方记得 settle", () => {
    const dir = tmp();
    const bundle = new EvidenceBundle(dir, OUTCOMES);
    bundle.fill("probe", { status: "ok" });
    bundle.writeManifest(META);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
    expect(manifest.steps.map((s: any) => [s.id, s.status])).toEqual([
      ["probe", "ok"],
      ["verdict", "unavailable"],
    ]);
    expect(manifest.steps[1].reason).toBe(OUTCOME_UNREACHED_REASON);
  });
});
