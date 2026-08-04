import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExportFileExistsError,
  buildHeader,
  defaultExportPath,
  resolveExportPath,
  writeExport,
} from "../src/tui/export";
import { parseSlash } from "../src/tui/slash";

describe("parseSlash /export", () => {
  it("parses bare /export", () => {
    const r = parseSlash("/export");
    expect(r.kind).toBe("export");
    if (r.kind === "export") expect(r.path).toBeUndefined();
  });

  it("parses /export <path>", () => {
    const r = parseSlash("/export /tmp/a.md");
    expect(r.kind).toBe("export");
    if (r.kind === "export") expect(r.path).toBe("/tmp/a.md");
  });

  it("ignores trailing whitespace", () => {
    const r = parseSlash("  /export   \n");
    expect(r.kind).toBe("export");
  });
});

describe("parseSlash /profile", () => {
  it("bare /profile opens picker", () => {
    const r = parseSlash("/profile");
    expect(r.kind).toBe("open_profile_picker");
  });

  it("/profile <name> still goes direct", () => {
    const r = parseSlash("/profile ro");
    expect(r.kind).toBe("switch_profile");
    if (r.kind === "switch_profile") expect(r.profileName).toBe("ro");
  });

  it("trailing whitespace alone still opens picker", () => {
    const r = parseSlash("/profile   ");
    expect(r.kind).toBe("open_profile_picker");
  });
});

describe("buildHeader", () => {
  it("includes all required metadata fields", () => {
    const out = buildHeader(
      {
        conversationId: "abcd1234efgh",
        profileName: "ro",
        serverUrl: "10.0.0.5:8080",
        readonly: true,
        modelTag: "openai/gpt-4o*",
        cliVersion: "0.0.1",
      },
      new Date("2026-05-10T07:30:00.000Z"),
    );
    expect(out).toContain("<!-- doctor export v1 -->");
    expect(out).toContain("conversation: abcd1234efgh");
    expect(out).toContain("profile: ro (server=10.0.0.5:8080, readonly=true)");
    expect(out).toContain("model: openai/gpt-4o*");
    expect(out).toContain("exported_at: 2026-05-10T07:30:00.000Z");
    expect(out).toContain("cli_version: 0.0.1");
    expect(out).toContain("已知行为");
    expect(out.endsWith("---\n\n")).toBe(true);
  });

  it("falls back to (none) when conversationId missing", () => {
    const out = buildHeader({
      conversationId: undefined,
      profileName: "x",
      serverUrl: "h:1",
      readonly: false,
      modelTag: "(no model)",
      cliVersion: "0.0.1",
    });
    expect(out).toContain("conversation: (none)");
  });
});

describe("defaultExportPath", () => {
  it("uses first 8 chars of conv id and yyyymmdd-HHMMSS", () => {
    const now = new Date(2026, 4, 10, 9, 8, 7); // local time, May
    const p = defaultExportPath("0123456789abcdef-uuid-thing", now);
    expect(p).toMatch(/\.doctor\/exports\/01234567-20260510-090807\.md$/);
  });

  it("falls back to noconv when id missing", () => {
    const p = defaultExportPath(undefined, new Date(2026, 0, 1, 0, 0, 0));
    expect(p).toMatch(/noconv-20260101-000000\.md$/);
  });
});

describe("resolveExportPath", () => {
  it("returns default path when input missing", () => {
    const p = resolveExportPath(undefined, "x");
    expect(p).toMatch(/\.doctor\/exports\//);
  });

  it("respects absolute path", () => {
    expect(resolveExportPath("/tmp/foo.md", "x")).toBe("/tmp/foo.md");
  });

  it("expands ~", () => {
    const p = resolveExportPath("~/x.md", "y");
    expect(p.startsWith("/")).toBe(true);
    expect(p.endsWith("/x.md")).toBe(true);
    expect(p).not.toContain("~");
  });
});

describe("writeExport", () => {
  it("creates parent directory and writes content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-export-"));
    const target = join(dir, "nested", "deep", "out.md");
    await writeExport("hello world\n", target);
    expect(readFileSync(target, "utf8")).toBe("hello world\n");
  });

  it("throws ExportFileExistsError when target already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-export-"));
    const target = join(dir, "out.md");
    writeFileSync(target, "old");
    await expect(writeExport("new", target)).rejects.toBeInstanceOf(ExportFileExistsError);
    expect(readFileSync(target, "utf8")).toBe("old");
  });
});
