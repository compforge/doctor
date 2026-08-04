import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runInit } from "../src/app/init";

function temporaryConfig(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "doctor-init-test-"));
  return { dir, path: join(dir, "config.yaml") };
}

describe("doctor init", () => {
  it("creates and enables a local profile for first use", async () => {
    const config = temporaryConfig();
    const kubeconfigPath = join(config.dir, "kubeconfig");
    writeFileSync(kubeconfigPath, "apiVersion: v1\n");

    await runInit({ config: config.path }, async () => kubeconfigPath);

    const persisted = parseYaml(readFileSync(config.path, "utf8"));
    expect(persisted).toEqual({
      default_profile: "local",
      profiles: {
        local: {
          readonly: true,
          kube: { kubeconfig_path: kubeconfigPath },
        },
      },
    });
    expect(statSync(config.path).mode & 0o777).toBe(0o600);
  });

  it("initializes an empty config file", async () => {
    const config = temporaryConfig();
    const kubeconfigPath = join(config.dir, "kubeconfig");
    writeFileSync(config.path, "  \n");
    writeFileSync(kubeconfigPath, "apiVersion: v1\n");

    await runInit({ config: config.path }, async () => kubeconfigPath);

    expect(parseYaml(readFileSync(config.path, "utf8")).default_profile).toBe("local");
  });

  it("does not prompt or change an existing non-empty config", async () => {
    const config = temporaryConfig();
    const original = "default_profile: dev\nprofiles:\n  dev:\n    readonly: true\n";
    writeFileSync(config.path, original);
    let prompted = false;

    await runInit({ config: config.path }, async () => {
      prompted = true;
      return "/unused";
    });

    expect(prompted).toBe(false);
    expect(readFileSync(config.path, "utf8")).toBe(original);
  });

  it("rejects a missing kubeconfig without creating config.yaml", async () => {
    const config = temporaryConfig();

    await expect(runInit({ config: config.path }, async () => join(config.dir, "missing")))
      .rejects.toThrow("kubeconfig path not found");
    expect(existsSync(config.path)).toBe(false);
  });
});
