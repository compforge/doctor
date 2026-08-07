import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPluginArchive } from "../../packages/plugin/scripts/pack";
import {
  installPlugin,
  loadActivePlugin,
  loadInstalledPlugin,
  readActivePluginRef,
  uninstallPlugin,
} from "../src/plugin";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "doctor-plugin-test-"));
}

describe("Plugin archive lifecycle", () => {
  it("builds a deterministic self-contained archive and loads the installed definition", async () => {
    const root = temporaryRoot();
    const pluginRoot = resolve(import.meta.dir, "../../plugins/example");
    const first = await buildPluginArchive(pluginRoot, join(root, "first"));
    const second = await buildPluginArchive(pluginRoot, join(root, "second"));
    const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(digest(first)).toBe(digest(second));

    const installRoot = join(root, "plugins");
    const result = await installPlugin(first, installRoot);
    expect(result).toMatchObject({ ref: "example@0.0.2", installed: true });
    expect(existsSync(join(result.path, "plugin.json"))).toBe(true);
    expect(existsSync(join(result.path, "plugin.mjs"))).toBe(true);
    expect(existsSync(join(result.path, ".doctor-install.json"))).toBe(true);
    expect(readActivePluginRef(installRoot)).toBe(result.ref);

    const plugin = await loadInstalledPlugin(result.ref, installRoot);
    expect(plugin.id).toBe("example");
    expect(plugin.version).toBe("0.0.2");
    expect(plugin.services.servicesWith("log").length).toBeGreaterThan(0);
    expect((await loadActivePlugin(installRoot))?.id).toBe("example");

    expect(await installPlugin(second, installRoot)).toMatchObject({
      ref: "example@0.0.2",
      installed: false,
    });
    uninstallPlugin(result.ref, installRoot);
    expect(existsSync(result.path)).toBe(false);
    expect(readActivePluginRef(installRoot)).toBeUndefined();
  });
});
