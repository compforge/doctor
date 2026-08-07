import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/app/config/config";
import {
  persistDefaultProfile,
  resolveWorkingProfile,
  resolveWorkingProfileName,
} from "../src/app/profile";

function makeTmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "doctor-profile-test-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("persistDefaultProfile", () => {
  it("updates default_profile and preserves comments", () => {
    const path = makeTmpFile(
      "config.yaml",
      `# customer environments
default_profile: dev
profiles:
  dev:
    readonly: true
  prod: # production
    readonly: true
`,
    );

    persistDefaultProfile(path, "prod");

    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("# customer environments");
    expect(raw).toContain("# production");
    expect(loadConfig(path).default_profile).toBe("prod");
  });

  it("materializes the synthetic default profile for an empty config", () => {
    const path = makeTmpFile("config.yaml", "");

    persistDefaultProfile(path, "default");

    const persisted = parseYaml(readFileSync(path, "utf8"));
    expect(persisted.default_profile).toBe("default");
    expect(persisted.profiles.default.readonly).toBe(true);
  });

  it("rejects an unknown profile without changing the file", () => {
    const path = makeTmpFile(
      "config.yaml",
      "default_profile: dev\nprofiles:\n  dev:\n    readonly: true\n",
    );
    const before = readFileSync(path, "utf8");

    expect(() => persistDefaultProfile(path, "missing")).toThrow(/not found/i);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("can repair an invalid default_profile by selecting an existing profile", () => {
    const path = makeTmpFile(
      "config.yaml",
      "default_profile: removed\nprofiles:\n  prod:\n    readonly: true\n",
    );

    persistDefaultProfile(path, "prod");

    expect(loadConfig(path).default_profile).toBe("prod");
  });
});

describe("resolveWorkingProfileName", () => {
  it("uses an explicit profile only for the current command", () => {
    const path = makeTmpFile(
      "config.yaml",
      "default_profile: dev\nprofiles:\n  dev:\n    readonly: true\n  prod:\n    readonly: true\n",
    );

    expect(resolveWorkingProfileName({ config: path })).toBe("dev");
    expect(resolveWorkingProfileName({ config: path, profile: "prod" })).toBe("prod");
    expect(loadConfig(path).default_profile).toBe("dev");
  });

  it("keeps Plugin config opaque while resolving the active profile", () => {
    const path = makeTmpFile(
      "config.yaml",
      [
        "default_profile: dev",
        "profiles:",
        "  dev:",
        "    readonly: true",
        "    plugin:",
        "      config:",
        "        region: example",
        "        feature:",
        "          enabled: true",
        "",
      ].join("\n"),
    );

    expect(resolveWorkingProfile({ config: path })).toMatchObject({
      name: "dev",
      profile: {
        plugin: {
          config: { region: "example", feature: { enabled: true } },
        },
      },
    });
  });

  it("uses the conversation-bound profile when resuming", () => {
    const statePath = makeTmpFile(
      "state.yaml",
      "last_conversation_id: c1\nconversations:\n  c1:\n    profile: prod\n    last_used_at: now\n",
    );

    expect(resolveWorkingProfileName({ resume: true }, statePath)).toBe("prod");
  });
});
