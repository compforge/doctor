import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { styleTerminalText, supportsTerminalColor, TerminalOutput } from "../src/terminal/output";

function typescriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("terminal output", () => {
  test("only enables color for an interactive terminal", () => {
    expect(supportsTerminalColor({ isTTY: true }, {})).toBe(true);
    expect(supportsTerminalColor({ isTTY: false }, {})).toBe(false);
    expect(supportsTerminalColor({ isTTY: true }, { TERM: "dumb" })).toBe(false);
  });

  test("NO_COLOR wins and FORCE_COLOR can enable redirected output explicitly", () => {
    expect(supportsTerminalColor({ isTTY: true }, { NO_COLOR: "" })).toBe(false);
    expect(supportsTerminalColor({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
    expect(supportsTerminalColor({ isTTY: true }, { FORCE_COLOR: "0" })).toBe(false);
  });

  test("resets every rendered line", () => {
    expect(styleTerminalText("done\nnext\n", "success")).toBe(
      "\u001B[1;32mdone\u001B[22;39m\n\u001B[1;32mnext\u001B[22;39m\n",
    );
  });

  test("raw writes remain byte-for-byte unchanged", () => {
    const chunks: Array<string | Uint8Array> = [];
    const output = new TerminalOutput({
      isTTY: true,
      write(chunk) {
        chunks.push(chunk);
        return true;
      },
    }, () => ({}));

    output.write("raw response\n");
    expect(chunks).toEqual(["raw response\n"]);
  });

  test("styles reusable choice fragments only when color is enabled", () => {
    const interactive = new TerminalOutput({
      isTTY: true,
      write() {
        return true;
      },
    }, () => ({}));
    const redirected = new TerminalOutput({
      isTTY: false,
      write() {
        return true;
      },
    }, () => ({}));

    expect(interactive.style("Embedding", "blue"))
      .toBe("\u001B[1;34mEmbedding\u001B[22;39m");
    expect(interactive.style("Multimodal", "magenta"))
      .toBe("\u001B[1;35mMultimodal\u001B[22;39m");
    expect(redirected.style("Embedding", "blue")).toBe("Embedding");
  });

  test("non-chat commands do not bypass the terminal output boundary", () => {
    const sourceRoot = join(import.meta.dir, "..", "src");
    const offenders = typescriptFiles(sourceRoot)
      .filter((path) => !path.endsWith("/app/repl.tsx"))
      .filter((path) => /process\.(?:stdout|stderr)\.write/.test(readFileSync(path, "utf8")))
      .map((path) => relative(sourceRoot, path));

    expect(offenders).toEqual([]);
  });
});
