import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bumpPluginVersion,
  checkPluginVersion,
  initializePluginVersion,
} from "../scripts/version";

function pluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-plugin-version-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@example/plugin",
    version: "0.0.1",
  }));
  writeFileSync(join(root, "src", "index.ts"), "export default {};\n");
  return root;
}

describe("Plugin version policy", () => {
  test("Plugin code changes require a version bump", () => {
    const root = pluginRoot();
    initializePluginVersion(root);
    expect(checkPluginVersion(root).version).toBe("0.0.1");

    writeFileSync(join(root, "src", "index.ts"), "export default { changed: true };\n");
    expect(() => checkPluginVersion(root)).toThrow("content changed without a version bump");

    expect(bumpPluginVersion(root).version).toBe("0.0.2");
    expect(checkPluginVersion(root).version).toBe("0.0.2");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version)
      .toBe("0.0.2");
  });

  test("Skill resource changes require the same Plugin version bump", () => {
    const root = pluginRoot();
    mkdirSync(join(root, "skills", "sample"), { recursive: true });
    const skill = join(root, "skills", "sample", "SKILL.md");
    writeFileSync(skill, "---\nname: sample\ndescription: sample\n---\n");
    initializePluginVersion(root);

    writeFileSync(skill, "---\nname: sample\ndescription: changed\n---\n");
    expect(() => checkPluginVersion(root)).toThrow("content changed without a version bump");

    expect(bumpPluginVersion(root, "0.1.0").version).toBe("0.1.0");
    expect(checkPluginVersion(root).version).toBe("0.1.0");
  });
});
