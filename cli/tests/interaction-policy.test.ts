import { expect, spyOn, test } from "bun:test";
import { CliCommand } from "../src/app/cli-command";
import { applyOptionDefaults } from "../src/app/command-defaults";
import { assumesYes, isInteractive, withInteractionOptions } from "../src/terminal/policy";
import { withTerminalInput } from "../src/terminal/interaction";
import { resolveApprovalGate } from "../src/terminal/approval";
import { CommandContext, CommandInputError, CommandStatus, defineCommand } from "../src/command";
import { inspectCommand } from "../src/collect/inspect/command";
import { dbCommand } from "../src/collect/db/command";
import { resolveInspectDependencySelection, resolveInspectDeploymentSelection } from "../src/collect/inspect/options";
import type { InspectConfig } from "../src/collect/inspect/model";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

test("yes suppresses even injected TTY, inherits across awaits and does not leak", async () => {
  await Promise.all([
    withInteractionOptions({ yes: true }, async () => {
      await Promise.resolve();
      expect(isInteractive(true)).toBe(false);
      expect(withInteractionOptions({}, assumesYes)).toBe(true);
      expect(withInteractionOptions({ yes: false }, () => isInteractive(true))).toBe(true);
      expect(() => withTerminalInput(async () => { throw new Error("must not prompt"); })).toThrow(CommandInputError);
      expect(await resolveApprovalGate({})({ id: "chosen", risk: "observe", title: "chosen", target: "test", impact: [] })).toMatchObject({ approved: true });
    }),
    withInteractionOptions({ yes: false }, async () => {
      await Promise.resolve();
      expect(isInteractive(true)).toBe(true);
    }),
  ]);
  expect(assumesYes()).toBe(false);
});

for (const args of [["-y", "child"], ["child", "-y"], ["child"]]) {
  test(`Commander scopes root/distribution yes: ${args.join(" ")}`, async () => {
    const root = new CliCommand().option("-y, --yes", "no questions", false).option("--no-yes");
    applyOptionDefaults(root, { yes: true });
    root.command("child").action(async () => {
      await Promise.resolve();
      expect(assumesYes()).toBe(true);
    });
    await root.parseAsync(args, { from: "user" });
    expect(assumesYes()).toBe(false);
  });
}

test("explicit no-yes overrides distribution default", async () => {
  const root = new CliCommand().option("-y, --yes", "no questions", false).option("--no-yes");
  applyOptionDefaults(root, { yes: true });
  root.command("child").action(() => { expect(assumesYes()).toBe(false); });
  await root.parseAsync(["child", "--no-yes"], { from: "user" });
});

test("required inspect/db inputs fail before Plugin or environment access", async () => {
  const context = new CommandContext({}, undefined, { yes: true });
  const plugin = spyOn(context, "resolvePlugin");
  const environment = spyOn(context, "ensureEnvironment");
  try {
    const inspect = await inspectCommand.run(context, {});
    expect(inspect.status).toBe(CommandStatus.Failed);
    if (inspect.status !== CommandStatus.Failed) throw new Error("expected input failure");
    expect(inspect.error).toBeInstanceOf(CommandInputError);
    expect(inspect.reason).toContain("--services");
    const db = await dbCommand.run(context, {});
    expect(db.status).toBe(CommandStatus.Failed);
    if (db.status !== CommandStatus.Failed) throw new Error("expected input failure");
    expect(db.error).toBeInstanceOf(CommandInputError);
    expect(db.reason).toContain("--show-databases");
    expect(plugin).not.toHaveBeenCalled();
    expect(environment).not.toHaveBeenCalled();
  } finally { plugin.mockRestore(); environment.mockRestore(); await context.disposeClients(); }
});

test("programmatic parent and child inherit invocation policy", async () => {
  const child = defineCommand({ name: "child", run: async () => {
    expect(isInteractive(true)).toBe(false);
    return { status: CommandStatus.Ok, artifacts: [], output: true };
  } });
  const parent = defineCommand({ name: "parent", run: (context) => child.run(context, {}) });
  const context = new CommandContext({});
  try {
    expect((await parent.run(context, { yes: true })).status).toBe(CommandStatus.Ok);
  } finally { await context.disposeClients(); }
});

test("yes does not select optional inspect collection; explicit false never prompts", async () => {
  const config: InspectConfig = {
    namespace: "demo", namespaceSource: "default", services: ["api"], servicesExplicit: true,
    format: "bundle", reportName: "test", profileName: "", kube: { namespace: "demo" },
  };
  const prompt = async () => { throw new Error("must not prompt"); };
  await withInteractionOptions({ yes: true }, async () => {
    expect(await resolveInspectDeploymentSelection({ config, interactive: true, prompt })).toBe(false);
    expect(await resolveInspectDependencySelection({ config, interactive: true, prompt })).toBe(false);
    expect(await resolveInspectDependencySelection({ config: { ...config, includeDependencies: true }, prompt })).toBe(true);
  });
  expect(await resolveInspectDeploymentSelection({ config: { ...config, includeDeploymentConfig: false }, interactive: true, prompt })).toBe(false);
  expect(await resolveInspectDependencySelection({ config: { ...config, includeDependencies: false }, interactive: true, prompt })).toBe(false);
});

test("TTY distribution CLI returns a failed manifest without prompting or contacting Kubernetes", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-yes-cli-"));
  try {
    const called = join(root, "kubectl-called");
    writeFileSync(join(root, "kubectl"), '#!/bin/sh\ntouch "$DOCTOR_TEST_CALLED"\nexit 99\n', { mode: 0o755 });
    for (const command of ["inspect", "db"]) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, join(import.meta.dir, "fixtures/noninteractive-cli.ts"), command, "--output", join(root, command)],
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, DOCTOR_TEST_CALLED: called, DOCTOR_CONFIG: "/missing/config" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
      });
      expect(result.exitCode, result.stderr.toString()).toBe(2);
      const manifest = JSON.parse(result.stdout.toString());
      expect(manifest.status).toBe("failed");
      expect(existsSync(called)).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
