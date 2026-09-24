import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { expandHome, loadConfig, resolveProfile } from "../../app/config/config";
import type { CommandProfile } from "../../command/context";

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
}, commandProfile?: CommandProfile): ResolvedDebugImage {
  const flag = opts.debugImage?.trim();
  if (flag) return { image: flag, source: "flag" };

  const configPath = opts.config ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
  try {
    const { name, profile } = commandProfile
      ? { name: commandProfile.name, profile: commandProfile.value }
      : resolveProfile(loadConfig(configPath), opts.profile);
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
}, commandProfile?: CommandProfile): ResolvedNamespace {
  const flag = opts.namespace?.trim();
  if (flag) return { namespace: flag, source: "flag" };

  const configPath = opts.config ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
  try {
    const { name, profile } = commandProfile
      ? { name: commandProfile.name, profile: commandProfile.value }
      : resolveProfile(loadConfig(configPath), opts.profile);
    const configured = typeof profile.namespace === "string" ? profile.namespace.trim() : "";
    if (configured) return { namespace: configured, source: `profile:${name}` };
  } catch (err) {
    if (opts.profile) throw err;
  }
  return { namespace: DEFAULT_COLLECT_NAMESPACE, source: "default" };
}

function readableKubeconfig(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function selectedKubeconfig(path: string, source: string): ResolvedKubeconfig {
  if (!readableKubeconfig(path)) throw new Error(`kubeconfig path not found or unreadable (${source}): ${path}`);
  return { kubeconfig: path, source };
}

/** Keep the path list for both kubectl and the TypeScript Kubernetes client to load. */
export function resolveKubectlKubeconfig(
  kubeconfigEnv = process.env.KUBECONFIG,
  defaultPath = join(homedir(), ".kube", "config"),
): ResolvedKubeconfig {
  if (kubeconfigEnv?.trim()) {
    const paths = kubeconfigEnv.split(delimiter).filter(Boolean);
    const unreadable = paths.find((path) => !readableKubeconfig(path));
    if (unreadable) {
      throw new Error(`KUBECONFIG 包含不存在或不可读取的 kubeconfig：${unreadable}`);
    }
    return { source: "env:KUBECONFIG" };
  }
  return selectedKubeconfig(defaultPath, "kubectl-default");
}

/** Select a source first, then check that it contains a readable kubeconfig before Kubernetes access. */
export function resolveCollectKubeconfig(opts: {
  kubeconfig?: string;
  profile?: string;
  config?: string;
}, commandProfile?: CommandProfile): ResolvedKubeconfig {
  if (opts.kubeconfig) return selectedKubeconfig(expandHome(opts.kubeconfig), "flag");
  const configPath = opts.config ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
  if (commandProfile) {
    const configured = commandProfile.value.kube?.kubeconfig_path;
    if (configured) {
      return selectedKubeconfig(expandHome(configured), `profile:${commandProfile.name}`);
    }
    return resolveKubectlKubeconfig();
  }
  if (opts.profile) {
    const { name, profile } = resolveProfile(loadConfig(configPath), opts.profile);
    return profile.kube?.kubeconfig_path
      ? selectedKubeconfig(expandHome(profile.kube.kubeconfig_path), `profile:${name}`)
      : resolveKubectlKubeconfig();
  }
  if (configPath === "") return resolveKubectlKubeconfig();
  const { name, profile } = resolveProfile(loadConfig(configPath), undefined);
  return profile.kube?.kubeconfig_path
    ? selectedKubeconfig(expandHome(profile.kube.kubeconfig_path), `profile:${name}`)
    : resolveKubectlKubeconfig();
}
