import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, loadConfig, resolveProfile } from "../../app/config/config";

export interface ResolvedKubeconfig {
  kubeconfig?: string;
  /** 来源说明，进日志与 manifest：flag / profile:<name> / kubectl-default */
  source: string;
}

export const DEFAULT_COLLECT_NAMESPACE = "default";

export interface ResolvedNamespace {
  namespace: string;
  source: "flag" | `profile:${string}` | "prompt" | "default";
}

export interface ResolvedDebugImage {
  image?: string;
  source: "flag" | `profile:${string}` | "unconfigured";
}

/** 调试镜像优先级：命令行 > 当前 profile；不提供公共镜像默认值。 */
export function resolveCollectDebugImage(opts: {
  debugImage?: string;
  profile?: string;
  config?: string;
}): ResolvedDebugImage {
  const flag = opts.debugImage?.trim();
  if (flag) return { image: flag, source: "flag" };

  const configPath = opts.config ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
  try {
    const { name, profile } = resolveProfile(loadConfig(configPath), opts.profile);
    const configured = profile.kube?.debug_image?.trim();
    return configured
      ? { image: configured, source: `profile:${name}` }
      : { source: "unconfigured" };
  } catch (err) {
    if (opts.profile) throw err;
    return { source: "unconfigured" };
  }
}

/** namespace 优先级：命令行 > 当前 profile > default。 */
export function resolveCollectNamespace(opts: {
  namespace?: string;
  profile?: string;
  config?: string;
}): ResolvedNamespace {
  const flag = opts.namespace?.trim();
  if (flag) return { namespace: flag, source: "flag" };

  const configPath = opts.config ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
  try {
    const { name, profile } = resolveProfile(loadConfig(configPath), opts.profile);
    const configured = typeof profile.namespace === "string" ? profile.namespace.trim() : "";
    if (configured) return { namespace: configured, source: `profile:${name}` };
  } catch (err) {
    if (opts.profile) throw err;
  }
  return { namespace: DEFAULT_COLLECT_NAMESPACE, source: "default" };
}

/**
 * kubeconfig 解析（配置驱动）：
 * 1. 显式 --kubeconfig 最优先；
 * 2. --profile 指定时取该 profile 的 kube.kubeconfig_path（没配则报错——显式指定不做静默回退）；
 * 3. 都没给时 best-effort 看 default profile：配了 kube 就用（含零配置合成的 default profile
 *    指向 ~/.kube/config），文件不存在或没配则交给 kubectl 自身默认查找。
 */
export function resolveCollectKubeconfig(opts: {
  kubeconfig?: string;
  profile?: string;
  config?: string;
}): ResolvedKubeconfig {
  if (opts.kubeconfig) return { kubeconfig: expandHome(opts.kubeconfig), source: "flag" };
  const configPath = opts.config ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
  if (opts.profile) {
    const { name, profile } = resolveProfile(loadConfig(configPath), opts.profile);
    if (!profile.kube?.kubeconfig_path) {
      throw new Error(`profile '${name}' 未配置 kube.kubeconfig_path，无法访问 Kubernetes`);
    }
    return { kubeconfig: expandHome(profile.kube.kubeconfig_path), source: `profile:${name}` };
  }
  try {
    const { name, profile } = resolveProfile(loadConfig(configPath), undefined);
    const path = profile.kube?.kubeconfig_path ? expandHome(profile.kube.kubeconfig_path) : undefined;
    if (path && existsSync(path)) return { kubeconfig: path, source: `profile:${name}` };
  } catch {
    // 配置有问题不阻塞采集，回落 kubectl 默认查找
  }
  return { source: "kubectl-default" };
}
