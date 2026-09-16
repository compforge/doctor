import type { Command, OptionValues } from "commander";
import type { Profile } from "./config/model";

const defaultOptions = Symbol("Commander default options");
type SourcedOptions = { [defaultOptions]?: { command: string; keys: ReadonlySet<string> } };

/** Preserve Commander provenance across the plain-object CLI adapter, without loading a profile. */
export function commandOptionsWithSources<T extends OptionValues = OptionValues>(command: Command): T {
  const options = command.optsWithGlobals<T>();
  const defaults = new Set(Object.keys(options).filter(
    key => command.getOptionValueSourceWithGlobals(key) === "default",
  ));
  return { ...options, [defaultOptions]: { command: command.name(), keys: defaults } };
}

/**
 * @rule Only explicit options override profile values. Leave profile-backed fields unset so
 * domain resolvers retain their profile provenance; defaults still apply when no value is configured.
 * Keep this mapping limited to options which already consume a profile field.
 */
export function withoutShadowedDefaults<T extends object>(options: T, profile: Profile): T {
  const source = (options as SourcedOptions)[defaultOptions];
  const configured: Record<string, unknown> = {
    kubeconfig: profile.kube?.kubeconfig_path,
    namespace: profile.namespace,
    debugImage: profile.kube?.debug_image,
    image: source?.command === "debug" ? profile.kube?.debug_image : undefined,
    prometheus: profile.prometheus?.url,
    sampleCount: profile.overview?.sample_count,
    collectConcurrency: profile.overview?.collect_concurrency,
  };
  const result = { ...options };
  for (const key of source?.keys ?? []) {
    if (configured[key] !== undefined) delete (result as Record<string, unknown>)[key];
  }
  const targetKeys = ["kubeconfig", "context", "namespace", "debugImage", "prometheus"];
  if (source?.command === "debug") targetKeys.push("image");
  for (const key of targetKeys) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === "string" && !value.trim()) {
      throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} 不能为空`);
    }
  }
  return result;
}
