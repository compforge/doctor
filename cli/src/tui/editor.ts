// Open $EDITOR for multi-line message composition.
//
// The caller must suspend Ink's raw-mode before invoking and restore it afterwards,
// because spawnSync inherits stdio and will conflict with Ink's terminal control.
// See usage in App.tsx where setRawMode is obtained via useStdin().

import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Synchronously open $EDITOR with `initialContent` pre-filled in a temp file.
 * Returns the edited text (trimmed), or null if the editor exited non-zero or
 * the content was unchanged / empty.
 *
 * Caller MUST call `setRawMode(false)` before and `setRawMode(true)` after.
 */
export function openEditorSync(initialContent: string): string | null {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const tmpDir = mkdtempSync(join(tmpdir(), "doctor-edit-"));
  const tmpFile = join(tmpDir, "message.txt");
  writeFileSync(tmpFile, initialContent, "utf8");

  try {
    const res = spawnSync(editor, [tmpFile], { stdio: "inherit" });
    if (res.status !== 0) return null;
    const text = readFileSync(tmpFile, "utf8").trim();
    return text || null;
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
