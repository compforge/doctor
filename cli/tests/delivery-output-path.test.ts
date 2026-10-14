import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverSerialized } from "../src/app/delivery";
import { CommandStatus } from "../src/command";
import type { Manifest } from "../src/command/manifest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "doctor-output-path-"));
  roots.push(root);
  chmodSync(root, 0o750);
  const directory = join(root, "evidence");
  mkdirSync(directory, { mode: 0o700 });
  const files = { summary: "summary.md", output: "output.json", text: "output.txt", html: "report.html" };
  const manifest: Manifest = {
    schemaVersion: 2, kind: "command", id: "test", title: "Test", source: { command: "test" },
    execution: { status: CommandStatus.Ok }, serialization: { status: "ok", errors: [] }, children: [],
    files: Object.fromEntries(Object.entries(files).map(([key, path]) => [key, { path, format: key, bytes: 2 }])),
  };
  for (const path of Object.values(files)) writeFileSync(join(directory, path), "{}", { mode: 0o600 });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return { root, directory };
}

for (const format of ["manifest", "default", "html", "json", "md", "text", "bundle"]) {
  test(`${format} delivers into missing nested parents without changing existing parent permissions`, async () => {
    const { root, directory } = fixture();
    const output = join(root, "missing", "nested", "result");
    expect(await deliverSerialized({ directory, options: { format, output }, code: 0, reportName: "test" })).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o750);
    for (const path of [join(root, "missing"), join(root, "missing", "nested")]) {
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
    const extensions = format === "default" ? ["html", "tar.gz"]
      : [format === "bundle" ? "tar.gz" : format === "text" ? "txt" : format];
    const paths = format === "manifest" ? [join(output, "manifest.json")] : extensions.map(extension => `${output}.${extension}`);
    for (const path of paths) {
      expect(statSync(path).size).toBeGreaterThan(0);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const manifest = JSON.parse(readFileSync(join(format === "manifest" ? output : directory, "manifest.json"), "utf8"));
    expect(manifest.delivery.status).toBe("ok");
    if (format === "manifest") {
      expect(readFileSync(join(output, "summary.md"), "utf8")).toBe("{}");
      expect(existsSync(directory)).toBe(false);
    }
  });
}

test("a parent occupied by a file fails delivery and retains the collected evidence", async () => {
  const { root, directory } = fixture();
  const parent = join(root, "blocked");
  writeFileSync(parent, "keep");
  expect(await deliverSerialized({ directory, options: { format: "manifest", output: join(parent, "nested", "result") }, code: 0, reportName: "test" })).toBe(false);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  expect(manifest.execution.status).toBe("ok");
  expect(manifest.delivery.status).toBe("failed");
  expect(manifest.delivery.location.directory).toBe(directory);
  expect(manifest.delivery.errors.join(" ")).toContain(parent);
  expect(readFileSync(join(directory, "summary.md"), "utf8")).toBe("{}");
  expect(readFileSync(parent, "utf8")).toBe("keep");
});

test("default delivery rejects an existing archive before publishing HTML", async () => {
  const { root, directory } = fixture();
  const output = join(root, "result");
  writeFileSync(`${output}.tar.gz`, "keep");
  expect(await deliverSerialized({ directory, options: { format: "default", output }, code: 0, reportName: "test" })).toBe(false);
  expect(existsSync(`${output}.html`)).toBe(false);
  expect(readFileSync(`${output}.tar.gz`, "utf8")).toBe("keep");
  expect(readFileSync(join(directory, "summary.md"), "utf8")).toBe("{}");
});
