import { createDeliveryPlan, assertDeliveryPathsAvailable } from "../src/app/delivery-plan";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CommandStatus, defineCommand } from "../src/command";
import { SerializeContext } from "../src/command/serialization/context";
import { runCommand } from "../src/app/command";
import { deliverSerialized } from "../src/app/delivery";

function preflight(options: { format?: string; output?: string }) {
  assertDeliveryPathsAvailable(createDeliveryPlan("doctor test", options));
}

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "doctor-output-preflight-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function captureOutput() {
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  return { stdout: () => stdout.mock.calls.map(([value]) => String(value)).join(""),
    stderr: () => stderr.mock.calls.map(([value]) => String(value)).join(""),
    restore: () => { stdout.mockRestore(); stderr.mockRestore(); } };
}

const cases = [
  { format: "json", output: "report", occupied: "report.json" },
  { format: "json", output: "report.json", occupied: "report.json" },
  { format: "md", output: "report", occupied: "report.md" },
  { format: "html", output: "report.html", occupied: "report.html" },
  { format: "bundle", output: "report", occupied: "report.tar.gz" },
  { format: "bundle", output: "report.tgz", occupied: "report.tgz" },
  { format: "default", output: "report", occupied: "report.html" },
  { format: "default", output: "report", occupied: "report.tar.gz" },
  { format: undefined, output: "report.json", occupied: "report.tar.gz" },
  { format: "default", output: "report.tgz", occupied: "report.html" },
  { format: "manifest", output: "evidence", occupied: "evidence" },
];
for (const fixture of cases) {
  test(`explicit output conflict stops preparation: ${fixture.format ?? "default"} ${fixture.output} / ${fixture.occupied}`, async () => {
    const directory = root();
    const occupied = join(directory, fixture.occupied);
    if (fixture.format === "manifest") mkdirSync(occupied);
    else writeFileSync(occupied, "keep-existing");
    const prepare = mock(async (_context: unknown, input: {}) => input);
    const query = mock(async () => ({ status: CommandStatus.Ok as const, output: undefined, artifacts: [] }));
    const spec = defineCommand({ name: "doctor db", prepare, run: query });
    const output = captureOutput();
    const previousCode = process.exitCode;
    try {
      // Even a broken local profile must not hide an already-known output collision.
      const config = join(directory, "broken.yaml"); writeFileSync(config, "profiles: [broken");
      await runCommand(spec, { config, format: fixture.format, output: join(directory, fixture.output) }, {}, { logLevel: "error" });
      expect(prepare).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(output.stderr()).toContain("--output 已存在");
      expect(output.stderr()).toContain(occupied);
      if (fixture.format === "manifest") {
        const manifest = JSON.parse(output.stdout());
        expect(manifest.execution.status).toBe("failed");
        expect(manifest.execution.reason).toContain(occupied);
        expect(manifest.delivery.location.directory).not.toBe(occupied);
        roots.push(manifest.delivery.location.directory);
        expect(existsSync(join(occupied, "manifest.json"))).toBe(false);
      } else expect(readFileSync(occupied, "utf8")).toBe("keep-existing");
    } finally { output.restore(); process.exitCode = previousCode; }
  });
}

test("an occupied basename does not conflict with its free JSON destination", async () => {
  const directory = root();
  const output = join(directory, "report"); writeFileSync(output, "basename is not the destination");
  const prepare = mock(async (_context: unknown, input: {}) => input);
  const query = mock(async () => ({ status: CommandStatus.Ok as const, output: undefined, artifacts: [] }));
  const spec = defineCommand({ name: "doctor db", prepare, run: query });
  const previousCode = process.exitCode;
  try {
    await runCommand(spec, { config: join(directory, "absent.yaml"), format: "json", output }, {}, { printProfile: false, logLevel: "error" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("basename is not the destination");
    expect(existsSync(output + ".json")).toBe(false); // Preflight never reserves or creates a destination.
  } finally { process.exitCode = previousCode; }
});

test("directories and dangling symlinks occupy output names; relative paths use the same rules", () => {
  const directory = root();
  const output = join(directory, "report.json");
  mkdirSync(output);
  expect(() => preflight({ format: "json", output: relative(process.cwd(), output) })).toThrow("已存在");
  rmSync(output, { recursive: true });
  symlinkSync(join(directory, "missing"), output);
  expect(existsSync(output)).toBe(false);
  expect(() => preflight({ format: "json", output })).toThrow("已存在");
  expect(lstatSync(output).isSymbolicLink()).toBe(true);
});

test("summary rejects an output path; all other plans can be preflighted immediately", () => {
  const directory = root();
  expect(() => preflight({ format: "summary", output: directory })).toThrow("不支持 --output");
  for (const format of ["default", "html", "json", "md", "bundle", "manifest"]) {
    expect(() => preflight({ format })).not.toThrow();
  }
});

async function evidence(directory: string): Promise<string> {
  const source = join(directory, "source");
  await SerializeContext.create(source, { name: "doctor db", serialize: async context => ({ files: {
    summary: context.writeText("summary.md", "# Result\n\nrows: 1\n"),
    diagnosis: context.writeJson("diagnosis.json", { rows: [{ id: "row1" }] }),
    report: context.writeText("report.html", "<h1>Result</h1>"),
  }, children: [] }) }, { status: CommandStatus.Ok, output: undefined, artifacts: [] });
  return source;
}

for (const fixture of cases) {
  test(`delivery rechecks conflicts after successful preflight: ${fixture.format ?? "default"} ${fixture.occupied}`, async () => {
    const directory = root();
    const source = await evidence(directory);
    const options = { format: fixture.format, output: join(directory, fixture.output) };
    const plan = createDeliveryPlan("doctor test", options);
    assertDeliveryPathsAvailable(plan);
    const occupied = join(directory, fixture.occupied);
    writeFileSync(occupied, "created-during-collection");
    const output = captureOutput();
    try {
      expect(await deliverSerialized({ directory: source, plan, code: 0 })).toBe(false);
      expect(readFileSync(occupied, "utf8")).toBe("created-during-collection");
      expect(JSON.parse(readFileSync(join(source, "diagnosis.json"), "utf8")).rows).toEqual([{ id: "row1" }]);
      const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
      expect(manifest.execution.status).toBe("ok");
      expect(manifest.delivery.status).toBe("failed");
      expect(manifest.delivery.exitCode).toBe(1);
      expect(manifest.delivery.location.directory).toBe(source);
      // Default delivery must check both paths before publishing either file.
      if (fixture.occupied === "report.tar.gz") expect(existsSync(join(directory, "report.html"))).toBe(false);
      if (fixture.format === "default" && fixture.occupied === "report.html") expect(existsSync(join(directory, "report.tar.gz"))).toBe(false);
    } finally { output.restore(); }
  });
}

for (const format of ["json", "html", "md", "bundle", "default", "manifest"] as const) {
  test(`a free ${format} destination is published at the preflight path`, async () => {
    const directory = root();
    const source = await evidence(directory);
    const path = join(directory, "report");
    const options = { format, output: path };
    const plan = createDeliveryPlan("doctor test", options);
    assertDeliveryPathsAvailable(plan);
    const output = captureOutput();
    try {
      expect(await deliverSerialized({ directory: source, plan, code: 0 })).toBe(true);
      for (const destination of format === "default" ? [path + ".html", path + ".tar.gz"]
        : format === "manifest" ? [join(path, "manifest.json")]
          : [path + (format === "bundle" ? ".tar.gz" : `.${format}`)]) expect(existsSync(destination)).toBe(true);
    } finally { output.restore(); }
  });
}

for (const options of [{ format: "unknown" }, { format: "summary", output: "unused.md" }]) {
  test(`invalid delivery options fail before command preparation: ${JSON.stringify(options)}`, async () => {
    const prepare = mock(async (_context: unknown, input: {}) => input);
    const run = mock(async () => ({ status: CommandStatus.Ok as const, output: undefined, artifacts: [] }));
    const spec = defineCommand({ name: "doctor test", prepare, run });
    const output = captureOutput();
    const previousCode = process.exitCode;
    try {
      await runCommand(spec, { config: join(root(), "absent.yaml"), ...options }, {}, { logLevel: "error" });
      expect(prepare).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      expect(output.stderr()).toContain("--format");
    } finally { output.restore(); process.exitCode = previousCode; }
  });
}

test("a missing parent is rejected before collection", async () => {
  const run = mock(async () => ({ status: CommandStatus.Ok as const, output: undefined, artifacts: [] }));
  const spec = defineCommand({ name: "doctor test", prepare: async (_context, input) => input, run });
  const output = captureOutput();
  const previousCode = process.exitCode;
  try {
    await runCommand(spec, { format: "json", output: join(root(), "missing", "report"), config: "" }, {}, { logLevel: "error" });
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(output.stderr()).toContain("ENOENT");
  } finally { output.restore(); process.exitCode = previousCode; }
});

test("archive publication does not overwrite a target created after the final check", async () => {
  const directory = root();
  const source = await evidence(directory);
  const plan = createDeliveryPlan("doctor db", { output: join(directory, "report") });
  assertDeliveryPathsAvailable(plan);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = spyOn(process.stdout, "write").mockImplementation(chunk => {
    // HTML was published after the shared late check; race the asynchronous tar publication.
    if (String(chunk).includes("report.html:")) writeFileSync(plan.archive!, "another invocation", { flag: "wx" });
    return true;
  });
  try {
    expect(await deliverSerialized({ directory: source, plan, code: 0 })).toBe(false);
    expect(readFileSync(plan.archive!, "utf8")).toBe("another invocation");
    expect(readFileSync(plan.file!.path, "utf8")).toContain("Result");
    expect(existsSync(join(source, "diagnosis.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")).delivery.status).toBe("failed");
  } finally { stderr.mockRestore(); stdout.mockRestore(); }
});

test("execution cannot redirect its preflighted destination by changing options", async () => {
  const directory = root();
  const options = { config: join(directory, "absent.yaml"), format: "json", output: join(directory, "original") };
  const run = mock(async () => {
    options.output = join(directory, "changed");
    options.format = "html";
    return { status: CommandStatus.Ok as const, output: { rows: 1 }, artifacts: [] };
  });
  const render = mock(async () => { throw new Error("JSON delivery must not render"); });
  const spec = defineCommand({ name: "doctor test", prepare: async (_context, input) => input, run, render,
    serialize: async (context, result) => ({ files: { output: context.writeJson("output.json", result.output) } }) });
  const output = captureOutput();
  const previousCode = process.exitCode;
  try {
    await runCommand(spec, options, {}, { logLevel: "error" });
    expect(process.exitCode).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    expect(existsSync(join(directory, "changed.html"))).toBe(false);
    const exported = JSON.parse(readFileSync(join(directory, "original.json"), "utf8"));
    expect(exported.result).toEqual({ rows: 1 });
    roots.push(join(exported.manifest, ".."));
  } finally { output.restore(); process.exitCode = previousCode; }
});

test("generated default destinations are also preflighted", () => {
  const cwd = process.cwd();
  const directory = root();
  try {
    process.chdir(directory);
    const plan = createDeliveryPlan("doctor test", {});
    writeFileSync(plan.archive!, "existing");
    process.chdir(cwd);
    expect(() => assertDeliveryPathsAvailable(plan)).toThrow(plan.archive!);
    expect(existsSync(plan.file!.path)).toBe(false);
    expect(readFileSync(plan.archive!, "utf8")).toBe("existing");
  } finally { process.chdir(cwd); }
});
