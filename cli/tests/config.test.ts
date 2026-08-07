import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  resolveProfile,
  profileToUpload,
  validateProfile,
} from "../src/app/config/config";
import type { Config } from "../src/app/config/model";

function makeTmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "doctor-cli-test-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("loadConfig", () => {
  it("parses a single-profile config", () => {
    const p = makeTmpFile(
      "config.yaml",
      `profiles:
  ro:
    server: 10.0.0.5:8080
    readonly: true
`,
    );
    const cfg = loadConfig(p);
    expect(cfg.profiles.ro.server).toBe("10.0.0.5:8080");
    expect(cfg.profiles.ro.readonly).toBe(true);
  });

  // 零配置可跑：缺文件 / 空文件 / 没有 profiles 都合成默认 default profile
  it("missing file yields default profile", () => {
    const cfg = loadConfig("/tmp/nope-doctor.yaml");
    expect(cfg.default_profile).toBe("default");
    expect(cfg.profiles.default.kube?.kubeconfig_path).toBe("~/.kube/config");
    expect(cfg.profiles.default.server).toBeUndefined();
  });

  it("empty file yields default profile", () => {
    const p = makeTmpFile("c.yaml", "");
    expect(loadConfig(p).default_profile).toBe("default");
  });

  it("missing profiles key yields default profile", () => {
    const p = makeTmpFile("c.yaml", "default_profile: x\n");
    expect(loadConfig(p).profiles.default).toBeDefined();
  });

  it("throws on malformed profiles (not a map)", () => {
    const p = makeTmpFile("c.yaml", "profiles: 123\n");
    expect(() => loadConfig(p)).toThrow(/profiles/i);
  });

  it("validates profile fields before returning typed config", () => {
    const readonly = makeTmpFile("readonly.yaml", "profiles:\n  dev:\n    readonly: yes\n");
    expect(() => loadConfig(readonly)).toThrow("profile 'dev'.readonly must be a boolean");

    const plugin = makeTmpFile(
      "plugin.yaml",
      "profiles:\n  dev:\n    readonly: true\n    plugin:\n      config: invalid\n",
    );
    expect(() => loadConfig(plugin)).toThrow("profile 'dev'.plugin.config must be a map");
  });
});

describe("resolveProfile", () => {
  const cfg: Config = {
    default_profile: "ro",
    profiles: {
      ro: { server: "h:1", readonly: true },
      full: { server: "h:1", readonly: false },
    },
  };

  it("uses --profile flag when given", () => {
    expect(resolveProfile(cfg, "full").name).toBe("full");
  });

  it("falls back to default_profile when no flag", () => {
    expect(resolveProfile(cfg, undefined).name).toBe("ro");
  });

  it("falls back to first profile when no default_profile and no flag", () => {
    const c2: Config = { profiles: { a: cfg.profiles.ro, b: cfg.profiles.full } };
    expect(resolveProfile(c2, undefined).name).toBe("a");
  });

  it("throws when --profile name not found", () => {
    expect(() => resolveProfile(cfg, "nope")).toThrow(/not found/i);
  });

  it("throws when default_profile points to non-existent name", () => {
    const c2: Config = { default_profile: "ghost", profiles: { ro: cfg.profiles.ro } };
    expect(() => resolveProfile(c2, undefined)).toThrow(/default_profile/i);
  });
});

describe("validateProfile", () => {
  const completeLlm = { provider: "openai", endpoint: "http://x/v1", api_key: "k", model: "m" };

  it("errors when kubeconfig_path file does not exist", () => {
    const result = validateProfile({
      server: "h:1",
      readonly: true,
      kube: { kubeconfig_path: "/tmp/nope-kc.yaml" },
      llm: completeLlm,
    });
    expect(result.errors.some((e) => /kubeconfig/i.test(e))).toBe(true);
  });

  it("warns when readonly=true but db.user looks admin", () => {
    const result = validateProfile({
      server: "h:1",
      readonly: true,
      db: { user: "root", password: "x" },
      llm: completeLlm,
    });
    expect(result.warnings.some((w) => w.includes("readonly"))).toBe(true);
  });

  it("errors when db missing user or password", () => {
    const result = validateProfile({
      server: "h:1",
      readonly: true,
      db: { user: "ro", password: "" },
      llm: completeLlm,
    });
    expect(result.errors.some((e) => /db\.password/.test(e))).toBe(true);
  });

  it("errors when llm fully missing", () => {
    const result = validateProfile({ server: "h:1", readonly: true });
    expect(result.errors.some((e) => e.toLowerCase().includes("llm"))).toBe(true);
  });

  it("allows local chat to resolve a model when llm is missing", () => {
    const result = validateProfile(
      { server: "h:1", readonly: true },
      { requireServerLlm: false },
    );
    expect(result.errors).toEqual([]);
  });

  it("errors when llm.api_key missing", () => {
    const result = validateProfile({
      server: "h:1",
      readonly: true,
      llm: { provider: "openai", endpoint: "http://x/v1", model: "m" },
    });
    expect(result.errors.some((e) => e.includes("api_key"))).toBe(true);
  });

  it("passes (no errors) when llm fully provided", () => {
    const result = validateProfile({ server: "h:1", readonly: true, llm: completeLlm });
    expect(result.errors).toEqual([]);
  });

  it("validates redis URL and optional fallback identity", () => {
    const valid = validateProfile({
      readonly: true,
      redis: { url: "rediss://redis.example.test:6380/0", username: "doctor", password: "secret" },
    });
    expect(valid.errors).toEqual([]);

    const invalid = validateProfile({ readonly: true, redis: { url: "mysql://redis.example.test", username: "doctor" } });
    expect(invalid.errors.some((e) => e.includes("redis.url"))).toBe(true);
    expect(invalid.errors.some((e) => e.includes("redis.password"))).toBe(true);
  });

  it("requires registry username and password together", () => {
    expect(validateProfile({
      readonly: true,
      registry: { username: "doctor", password: "secret" },
    }).errors).toEqual([]);
    expect(validateProfile({
      readonly: true,
      registry: { username: "doctor" },
    }).errors.some((e) => e.includes("registry.password"))).toBe(true);
  });

  it("validates Prometheus URL, credentials and request limits", () => {
    expect(validateProfile({
      readonly: true,
      prometheus: {
        url: "https://prometheus.example/prefix",
        username: "doctor",
        password: "secret",
        timeout_ms: 5_000,
        max_response_bytes: 1024,
      },
    }).errors).toEqual([]);
    const invalid = validateProfile({
      readonly: true,
      prometheus: { url: "redis://prometheus", username: "doctor", timeout_ms: 0 },
    });
    expect(invalid.errors.some((error) => error.includes("prometheus.url"))).toBe(true);
    expect(invalid.errors.some((error) => error.includes("prometheus.password"))).toBe(true);
    expect(invalid.errors.some((error) => error.includes("prometheus.timeout_ms"))).toBe(true);
  });
});

describe("profileToUpload", () => {
  it("reads kubeconfig file content into wire ProfileUpload", () => {
    const kc = makeTmpFile("kc.yaml", "apiVersion: v1\nkind: Config\n");
    const up = profileToUpload({
      server: "h:1",
      readonly: true,
      kube: { kubeconfig_path: kc },
      db: { user: "ro", password: "secret" },
    });
    expect(up.readonly).toBe(true);
    expect(up.kube?.kubeconfig).toContain("apiVersion: v1");
    expect(up.db?.user).toBe("ro");
    expect(up.db?.password).toBe("secret");
    expect(up.db?.host_override).toBeUndefined();
  });

  it("expands ~ in kubeconfig_path", () => {
    expect(() =>
      profileToUpload({
        server: "h:1",
        readonly: true,
        kube: { kubeconfig_path: "~/definitely-not-here.yaml" },
      }),
    ).toThrow(/ENOENT|not found/i);
  });
});
