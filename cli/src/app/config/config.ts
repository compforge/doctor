import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProfileUpload } from "../../protocol";
import type { Config, Profile } from "./model";

export const DEFAULT_PROFILE = "default";

// 零配置可跑（能力阶梯第 0 级）：没有 config.yaml 也视为有一个 default profile，
// kubeconfig 指向 kubectl 惯例默认位置——doctor mem / doctor trace 开箱即用；
// 问答等更高能力随 profile 补齐 llm / server 自动解锁，不靠显式"模式"开关。
function defaultConfig(): Config {
  return {
    default_profile: DEFAULT_PROFILE,
    profiles: {
      [DEFAULT_PROFILE]: { readonly: true, kube: { kubeconfig_path: "~/.kube/config" } },
    },
  };
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) return defaultConfig();
  const raw = readFileSync(path, "utf8");
  const data = parseYaml(raw) as unknown;
  // 空文件 / 没写 profiles / profiles 为空 map：同样按零配置对待，不再报错
  if (!data) return defaultConfig();
  if (typeof data !== "object" || ("profiles" in data && (typeof (data as { profiles: unknown }).profiles !== "object" || (data as { profiles: unknown }).profiles === null))) {
    throw new Error(`config missing 'profiles' map: ${path}`);
  }
  const cfg = data as Config;
  if (!cfg.profiles || Object.keys(cfg.profiles).length === 0) return defaultConfig();
  return cfg;
}

export interface ResolvedProfile {
  name: string;
  profile: Profile;
}

export function resolveProfile(cfg: Config, flag: string | undefined): ResolvedProfile {
  const names = Object.keys(cfg.profiles);
  if (names.length === 0) throw new Error("config has no profiles");

  if (flag) {
    const p = cfg.profiles[flag];
    if (!p) {
      throw new Error(`profile '${flag}' not found. available: ${names.join(", ")}`);
    }
    return { name: flag, profile: p };
  }

  if (cfg.default_profile) {
    const p = cfg.profiles[cfg.default_profile];
    if (!p) {
      throw new Error(
        `default_profile '${cfg.default_profile}' not found. available: ${names.join(", ")}`,
      );
    }
    return { name: cfg.default_profile, profile: p };
  }

  const first = names[0];
  return { name: first, profile: cfg.profiles[first] };
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateProfile(
  p: Profile,
  options: { requireServerLlm?: boolean } = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (p.kube?.kubeconfig_path) {
    const path = expandHome(p.kube.kubeconfig_path);
    if (!existsSync(path)) {
      errors.push(`kubeconfig path not found: ${p.kube.kubeconfig_path}`);
    }
  }

  if (p.db) {
    if (!p.db.user) errors.push("db.user 必填（profile 只管 DB 身份，user/password 必须成对）");
    if (!p.db.password) errors.push("db.password 必填（profile 只管 DB 身份，user/password 必须成对）");
    if (p.readonly && p.db.user && /^(root|admin|rw)$/i.test(p.db.user)) {
      warnings.push(
        "profile readonly=true 但 db.user 看起来像 admin/root/rw — readonly 当前仅意图层，凭据是否真只读由用户保证",
      );
    }
  }

  if (p.redis?.url) {
    try {
      const url = new URL(p.redis.url);
      if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
        errors.push("redis.url 只支持 redis:// 或 rediss://");
      }
    } catch {
      errors.push("redis.url 不是有效 URL");
    }
  }
  if (p.redis?.username && !p.redis.password) {
    errors.push("redis.username 已配置时 redis.password 必填");
  }
  if (!!p.registry?.username !== !!p.registry?.password) {
    errors.push("registry.username / registry.password 必须成对配置");
  }
  if (p.prometheus) {
    try {
      const url = new URL(p.prometheus.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.push("prometheus.url 只支持 http:// 或 https://");
      }
    } catch {
      errors.push("prometheus.url 不是有效 URL");
    }
    if (!!p.prometheus.username !== !!p.prometheus.password) {
      errors.push("prometheus.username / prometheus.password 必须成对配置");
    }
    if (p.prometheus.timeout_ms !== undefined && p.prometheus.timeout_ms <= 0) {
      errors.push("prometheus.timeout_ms 必须大于 0");
    }
    if (p.prometheus.max_response_bytes !== undefined && p.prometheus.max_response_bytes <= 0) {
      errors.push("prometheus.max_response_bytes 必须大于 0");
    }
  }

  // 兼容远端模式：doctor-server 裸装无默认，配置 server 时凭据必须可随 profile 上传。
  if (p.server && options.requireServerLlm !== false) {
    const missingLlm: string[] = [];
    if (!p.llm?.provider) missingLlm.push("provider");
    if (!p.llm?.api_key) missingLlm.push("api_key");
    if (!p.llm?.model) missingLlm.push("model");
    if (missingLlm.length) {
      errors.push(`llm.${missingLlm.join("/")} 必填（server 端不读环境变量、不带默认）`);
    }
  }

  return { errors, warnings };
}

export function profileToUpload(p: Profile): ProfileUpload {
  const upload: ProfileUpload = { readonly: p.readonly };

  if (p.kube?.kubeconfig_path) {
    const path = expandHome(p.kube.kubeconfig_path);
    if (!existsSync(path)) {
      throw new Error(`kubeconfig not found: ${p.kube.kubeconfig_path}`);
    }
    upload.kube = { kubeconfig: readFileSync(path, "utf8") };
  }

  if (p.db) {
    if (!p.db.user || !p.db.password) {
      throw new Error("db.user / db.password 必填（profile 只管 DB 身份）");
    }
    upload.db = {
      user: p.db.user,
      password: p.db.password,
      ...(p.db.host_override ? { host_override: p.db.host_override } : {}),
      ...(p.db.port_override ? { port_override: p.db.port_override } : {}),
    };
  }
  if (p.llm) upload.llm = { ...p.llm };

  return upload;
}

export function expandHome(path: string): string {
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}
