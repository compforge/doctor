import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildNodeSeaDoctor } from "../scripts/build-node-sea-doctor";

test.skipIf(!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))("Node SEA renders through FFI without node_modules and cleans extracted assets", async () => {
  if ((process.platform !== "darwin" && process.platform !== "linux")
    || (process.arch !== "arm64" && process.arch !== "x64")) return;
  const root = mkdtempSync(join(tmpdir(), "doctor-sea-test-"));
  const entry = join(root, "entry.ts");
  try {
    // Resolve at build time only: the executable must work in a directory with no installed packages.
    const core = resolve(import.meta.dir, "../node_modules/@opentui/core");
    writeFileSync(entry, `
import { createTestRenderer } from ${JSON.stringify(join(core, "testing.js"))};
import { TextRenderable } from ${JSON.stringify(join(core, "index.node.js"))};
const view = await createTestRenderer({ width: 60, height: 10 });
try {
  view.renderer.root.add(new TextRenderable(view.renderer, { content: "SEA 中文 renderer OK" }));
  await view.renderOnce();
  if (!view.captureCharFrame().includes("SEA 中文 renderer OK")) throw new Error("Missing rendered text");
  console.log(JSON.stringify({ assets: process.env.OTUI_ASSET_ROOT, commands: __DOCTOR_COMMANDS__, runtime: process.version }));
} finally { view.renderer.destroy(); }
`);
    const outfile = join(root, "doctor-sea-test");
    await buildNodeSeaDoctor({
      entry, outfile, target: { platform: process.platform, arch: process.arch }, commands: "inspect,plugin",
    });
    rmSync(entry);
    const child = Bun.spawnSync([outfile], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString().trim());
    expect(result.runtime).toBe("v26.4.0");
    expect(result.commands).toBe("inspect,plugin");
    expect(existsSync(result.assets)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
