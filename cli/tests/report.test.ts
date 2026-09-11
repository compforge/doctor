import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/app/command";
import { CommandStatus, defineCommand, type CommandInput, type CommandResult } from "../src/command";
import { RenderContext } from "../src/report/context";
import { evidencePage } from "../src/report/evidence";
import { renderReportHtml } from "../src/report/html";
import { composeReports, type Report } from "../src/report/model";
import { readReport } from "./report-fixture";

const ok = (artifacts: CommandResult<void>["artifacts"] = []): CommandResult<void> => ({ status: CommandStatus.Ok, output: undefined, artifacts });

test("concurrent composition reuses one render per result while separate invocations stay distinct", async () => {
  let calls = 0;
  const command = defineCommand<CommandInput, void>({ name: "test", run: async () => ok(),
    render: async () => { calls++; await Bun.sleep(1); return { title: "Test", sections: [] }; },
  });
  const renderer = new RenderContext([], "test");
  const result = ok();
  const reports = await Promise.all([renderer.render(command, result), renderer.render(command, result)]);
  expect(reports[0]).toBe(reports[1]);
  expect(calls).toBe(1);
  await renderer.render(command, ok());
  expect(calls).toBe(2);
});

test("shared view materializes once but retains two business identities even with identical HTML", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-report-shared-"));
  const artifact = { id: "shared", command: "trace", path: root };
  const context = new RenderContext([artifact], "test");
  let writes = 0;
  try {
    const pages = await Promise.all(["a", "b"].map(key => evidencePage(context, artifact,
      { title: "Trace", status: CommandStatus.Ok, subject: { key, label: key } }, async () => {
        writes++; await Bun.sleep(1); context.write(artifact, "<!doctype html><p>shared trace</p>");
      })));
    expect(writes).toBe(1);
    const report = composeReports("Collect", pages.map(page => ({ title: "Trace", sections: [
      { id: "trace", title: "Trace", status: CommandStatus.Ok, pages: [page] },
    ] })));
    expect(report.sections[0]!.pages).toHaveLength(2);
    const archive = readReport(renderReportHtml(report, context));
    expect(archive.index.sections[0]!.pages.map(page => page.subject?.key)).toEqual(["a", "b"]);
    expect(new Set(archive.index.sections[0]!.pages.map(page => page.entry)).size).toBe(1);
    expect(Object.keys(archive.entries).filter(name => name.endsWith(".html"))).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const commands of [1, 2]) for (const subjects of [1, 2]) test(`report keeps explicit dimensions: ${commands} commands × ${subjects} subjects`, () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-report-dimensions-"));
  const artifact = { id: "evidence", command: "test", path: root };
  const context = new RenderContext([artifact], "test");
  try {
    const report: Report = { title: "Collect", sections: Array.from({ length: commands }, (_, command) => ({
      id: `command-${command}`, title: `Command ${command}`, status: CommandStatus.Partial,
      pages: Array.from({ length: subjects }, (_, subject) => {
        const file = `${command}-${subject}.html`;
        context.write(artifact, `<h1>${command}/${subject}</h1>`, file);
        return context.page(artifact, { title: "Result", status: CommandStatus.Partial, subject: { key: String(subject), label: String(subject) } }, file);
      }),
    })) };
    const html = renderReportHtml(report, context);
    const archive = readReport(html);
    expect(archive.index.sections).toHaveLength(commands);
    for (const section of archive.index.sections) expect(section.pages).toHaveLength(subjects);
    expect(html.match(/<iframe /g)).toHaveLength(1);
    expect(html).not.toContain('srcdoc="');
    expect(html).not.toContain(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("renderer failure preserves evidence and delivers successful siblings with nonzero exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-render-failure-"));
  const output = join(root, "result.html");
  const source = join(root, "evidence");
  const previous = process.exitCode;
  const failure = defineCommand<CommandInput, void>({ name: "doctor trace", run: async () => ok(),
    render: async () => { throw new Error("cannot render trace"); },
  });
  const rootCommand = defineCommand<CommandInput, void>({ name: "doctor collect",
    run: async context => {
      mkdirSync(source); writeFileSync(join(source, "raw.txt"), "retained raw evidence");
      return ok([context.artifacts.add({ command: "log", path: source })]);
    },
    render: async (context, result) => {
      const page = await evidencePage(context, result.artifacts[0]!, { title: "Log", status: CommandStatus.Ok }, () => {
        context.write(result.artifacts[0]!, "<h1>available log</h1>");
      });
      return composeReports("Collect", [await context.render(failure, ok()), {
        title: "Log", sections: [{ id: "log", title: "Log", status: CommandStatus.Ok, pages: [page] }],
      }]);
    },
  });
  try {
    await runCommand(rootCommand, { config: join(root, "absent.yaml"), format: "html", output }, {}, { printProfile: false });
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(source, "raw.txt"))).toBeTrue();
    const archive = readReport(readFileSync(output, "utf8"));
    expect(archive.index.sections[0]!.pages[0]!.renderError).toBe("cannot render trace");
    expect(archive.index.sections[0]!.pages[0]!.status).toBe(CommandStatus.Ok);
    expect(archive.pages).toContain("available log");
  } finally { process.exitCode = previous ?? 0; rmSync(root, { recursive: true, force: true }); }
});

test("raw JSON delivery never invokes the renderer", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-raw-render-"));
  const previous = process.exitCode;
  let rendered = false;
  const command = defineCommand<CommandInput, void>({ name: "doctor raw",
    run: async context => {
      const source = join(root, "evidence"); mkdirSync(source); writeFileSync(join(source, "diagnosis.json"), '{"data":1}');
      return ok([context.artifacts.add({ command: "raw", path: source })]);
    },
    render: async () => { rendered = true; return { title: "Raw", sections: [] }; },
  });
  try {
    const output = join(root, "result.json");
    await runCommand(command, { config: join(root, "absent.yaml"), format: "json", output }, {}, { printProfile: false });
    expect(rendered).toBeFalse(); expect(process.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ data: 1 });
  } finally { process.exitCode = previous ?? 0; rmSync(root, { recursive: true, force: true }); }
});

test("large shared pages keep full content while labels stay out of executable markup", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-report-archive-size-"));
  const artifact = { id: "large", command: "trace", path: root };
  const context = new RenderContext([artifact], "test");
  const label = '</script><script>alert("field")</script>';
  const content = `<pre>${"完整证据".repeat(100000)}</pre>`;
  try {
    context.write(artifact, content);
    const pages = ["a", "b"].map(key => context.page(artifact, {
      title: label, status: CommandStatus.Ok, subject: { key, label },
    }));
    const html = renderReportHtml({ title: label, sections: [{ id: "trace", title: label, status: CommandStatus.Ok, pages }] }, context);
    const archive = readReport(html);
    expect(archive.pages).toBe(content);
    expect(archive.index.sections[0]!.pages.map(page => page.title)).toEqual([label, label]);
    expect(html).not.toContain(label);
    expect(html.length).toBeLessThan(content.length / 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
