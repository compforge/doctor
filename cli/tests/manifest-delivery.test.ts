import { serializeEvidenceResult } from "../src/collect/serialize";
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandContext, CommandStatus, defineCommand } from "../src/command";
import { commandOptions } from "../src/command/options";
import { EvidenceBundle } from "../src/collect/evidence";
import { finalizeCommand } from "../src/app/finalize";
import { finalizeResult } from "./report-fixture";
import { runCommand } from "../src/app/command";
import { useLogger, withLogger } from "../src/terminal/log";

const evidenceSpec = defineCommand({ name: "doctor log", serialize: serializeEvidenceResult,
  prepare: async (_context, input) => input, run: async () => ({ status: CommandStatus.Ok, output: undefined, artifacts: [] }) });
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "doctor-manifest-test-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function captureOutput() {
  let stdout = "", stderr = "";
  const out = spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += String(chunk); return true; });
  const err = spyOn(process.stderr, "write").mockImplementation(chunk => { stderr += String(chunk); return true; });
  return { json: () => JSON.parse(stdout), stderr: () => stderr, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

for (const status of [CommandStatus.Ok, CommandStatus.Partial, CommandStatus.Failed, CommandStatus.Cancelled]) {
  test(`manifest retains private evidence and exact ${status} status without rendering`, async () => {
    const source = join(root(), "source");
    const bundle = new EvidenceBundle(source);
    bundle.addStep({ id: "missing", title: "Unavailable Pod", status: "unavailable", risk: "observe", reason: "permission denied" });
    bundle.addStep({ id: "limited", title: "Limited raw", status: "ok", risk: "observe", output: "x".repeat(600_000) });
    bundle.writeManifest({ doctorVersion: "test", target: { namespace: "test", services: ["api"] }, inspectionFacts: {}, params: {}, startedAt: "now", finishedAt: "now" });
    writeFileSync(join(source, "diagnosis.json"), JSON.stringify({ coverage: [{ status: "insufficient" }] }));
    const context = new CommandContext({});
    context.artifacts.add({ command: "log", path: source, id: "a" });
    const render = async () => { throw new Error("manifest must not render HTML"); };
    const output = captureOutput();
    try {
      const code = status === CommandStatus.Cancelled ? 130 : status === CommandStatus.Failed ? 1 : 0;
      expect(await finalizeCommand({ spec: { name: "doctor log", run: async () => { throw new Error("must not collect"); }, serialize: serializeEvidenceResult, render }, code, result: { status, output: undefined, artifacts: context.artifacts.list() }, context, delivery: { format: "manifest" } })).toBe(code);
      const manifest = output.json();
      roots.push(manifest.bundle_root);
      expect(manifest.status).toBe(status);
      expect(manifest.exit_code).toBe(code);
      expect(manifest.children).toEqual([]);
      const artifact = manifest;
      expect(artifact.target).toEqual({ namespace: "test", services: ["api"] });
      expect(artifact.steps[0].reason).toBe("permission denied");
      expect(artifact.steps[1].truncation.reason).toBe("raw_byte_limit");
      expect(readFileSync(join(manifest.bundle_root, artifact.files["diagnosis.json"].path), "utf8")).toContain("insufficient");
      expect(statSync(manifest.bundle_root).mode & 0o777).toBe(0o700);
      expect(statSync(join(manifest.bundle_root, "manifest.json")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(manifest.bundle_root, "manifest.json"), "utf8"))).toEqual(manifest);
      expect(existsSync(join(manifest.bundle_root, "report.html"))).toBeFalse();
      expect(existsSync(source)).toBe(code !== 0);
    } finally { output.restore(); await context.disposeClients(); }
  });
}

test("explicit output, missing artifact and collisions preserve evidence and return JSON failures", async () => {
  const directory = root();
  const context = new CommandContext({});
  const source = join(directory, "source"); mkdirSync(source); writeFileSync(join(source, "raw.txt"), "evidence");
  context.artifacts.add({ command: "log", path: source });
  context.artifacts.add({ command: "log", path: join(directory, "missing") });
  let output = captureOutput();
  try {
    expect(await finalizeResult(context, evidenceSpec, { status: CommandStatus.Partial, output: undefined, artifacts: context.artifacts.list() }, { format: "manifest", output: join(directory, "result") })).toBe(1);
    const manifest = output.json();
    expect(manifest.serialization.status).toBe("failed");
    expect(manifest.retained_artifacts).toHaveLength(2);
    const raw = Object.values(manifest.files).find((file: any) => file.path.endsWith("/raw.txt")) as { path: string };
    expect(readFileSync(join(manifest.bundle_root, raw.path), "utf8")).toBe("evidence");
    expect(output.json().execution.status).toBe("partial");
  } finally { output.restore(); }
  output = captureOutput();
  try {
    expect(await finalizeResult(context, evidenceSpec, { status: CommandStatus.Ok, output: undefined, artifacts: context.artifacts.list() }, { format: "manifest", output: source })).toBe(1);
    expect(output.json().delivery.status).toBe("failed");
    expect(readFileSync(join(source, "raw.txt"), "utf8")).toBe("evidence");
  } finally { output.restore(); }
});

test("manifest refuses external symlinks without changing their target permissions", async () => {
  const directory = root();
  const secret = join(directory, "secret"); writeFileSync(secret, "private", { mode: 0o640 });
  const source = join(directory, "source"); mkdirSync(source); symlinkSync(secret, join(source, "link"));
  const context = new CommandContext({}); context.artifacts.add({ command: "log", path: source });
  const output = captureOutput();
  try {
    expect(await finalizeResult(context, evidenceSpec, { status: CommandStatus.Ok, output: undefined, artifacts: context.artifacts.list() }, { format: "manifest", output: join(directory, "result") })).toBe(1);
    expect(output.json().retained_artifacts).toHaveLength(1);
    expect(statSync(secret).mode & 0o777).toBe(0o640);
  } finally { output.restore(); }
});

test("silent logging is independent of the collectors Bundle format", async () => {
  const context = new CommandContext({}, undefined, { format: "manifest" });
  expect(commandOptions(context).format).toBe("bundle");
  const output = captureOutput();
  try {
    await withLogger("silent", async () => { await Promise.resolve(); useLogger().info("progress\n"); });
    expect(output.stderr()).toBe("");
  } finally { output.restore(); await context.disposeClients(); }
});

test("root lifecycle emits JSON for preflight failure and preserves a partial child result", async () => {
  const directory = root();
  const config = join(directory, "config.yaml"); writeFileSync(config, "profiles: [broken");
  const oldCode = process.exitCode;
  const spec = defineCommand({ name: "doctor test", prepare: async (_context, input) => input, run: async () => ({ status: CommandStatus.Partial as const, output: undefined, artifacts: [] }) });
  for (const invalid of [true, false]) {
    const output = captureOutput();
    try {
      await runCommand(spec, { config: invalid ? config : join(directory, "absent.yaml"), format: "manifest", output: join(directory, invalid ? "failure" : "partial") }, {}, { logLevel: "silent" });
      expect(output.json().status).toBe(invalid ? "failed" : "partial");
      expect(output.json().children).toEqual([]);
      expect(output.json().schemaVersion).toBe(1);
      expect(output.json().executionId).toEqual(expect.any(String));
      expect(process.exitCode).toBe(invalid ? 1 : 0);
    } finally { output.restore(); process.exitCode = oldCode; }
  }
});

test("silent execution logs do not suppress manifest delivery", async () => {
  const output = captureOutput();
  const oldCode = process.exitCode;
  const spec = defineCommand({ name: "doctor test", prepare: async (_context, input) => {
    useLogger().info("preparing\n");
    return input;
  }, run: async () => {
    useLogger().info("collecting\n");
    return { status: CommandStatus.Ok as const, output: undefined, artifacts: [] };
  } });
  try {
    await runCommand(spec, { config: join(root(), "absent.yaml"), format: "manifest" }, {}, { logLevel: "silent" });
    expect(output.json().status).toBe("ok");
    expect(output.stderr()).toBe("");
  } finally { output.restore(); process.exitCode = oldCode; }
});
