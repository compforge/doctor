import { terminalStdout } from "../terminal/output";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "../terminal/selection";
import { loadConfig, resolveProfile } from "./config/config";
import { loadState, resolveResumeTarget } from "./config/state";
import type { Config, Profile } from "./config/model";

export interface ProfileCommandOptions {
  config?: string;
}

export interface WorkingProfileOptions extends ProfileCommandOptions {
  profile?: string;
  resume?: string | true;
}

export function resolveConfigPath(explicit?: string): string {
  return explicit ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
}

export function resolveWorkingProfileName(
  opts: WorkingProfileOptions,
  statePath = join(homedir(), ".doctor", "state.yaml"),
): string {
  if (opts.profile && opts.resume !== undefined) {
    throw new Error("--profile and --resume are mutually exclusive (--resume already implies a profile)");
  }
  if (opts.resume !== undefined) {
    return resolveResumeTarget(loadState(statePath), opts.resume).profile;
  }
  return resolveProfile(loadConfig(resolveConfigPath(opts.config)), opts.profile).name;
}

function hasPersistedProfiles(raw: string): boolean {
  if (!raw.trim()) return false;
  const data = parseYaml(raw) as unknown;
  if (!data || typeof data !== "object") return false;
  const profiles = (data as { profiles?: unknown }).profiles;
  return !!profiles && typeof profiles === "object" && Object.keys(profiles).length > 0;
}

/** 只定点更新 default_profile，避免重写用户配置里的注释和凭据格式。 */
export function persistDefaultProfile(path: string, name: string): void {
  const config = loadConfig(path);
  resolveProfile(config, name);

  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  let next: string;
  if (hasPersistedProfiles(raw)) {
    const document = parseDocument(raw);
    if (document.errors.length > 0) {
      throw new Error(`invalid config yaml: ${path}: ${document.errors[0]!.message}`);
    }
    document.set("default_profile", name);
    next = document.toString();
  } else {
    next = stringifyYaml({ ...config, default_profile: name });
  }

  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, next, { encoding: "utf8", mode });
  renameSync(temporaryPath, path);
}

function profileSummary(name: string, profile: Profile, current: string | undefined): string {
  const details = [profile.readonly ? "readonly" : "read-write"];
  if (profile.namespace) details.push(`namespace=${profile.namespace}`);
  if (profile.server) details.push(`server=${profile.server}`);
  return `${name === current ? "*" : " "} ${name} (${details.join(", ")})`;
}

async function selectProfile(config: Config, current: string | undefined): Promise<string | undefined> {
  const names = Object.keys(config.profiles);
  printNumberedChoices(names, "Profiles（* = 当前）:", (name) =>
    profileSummary(name, config.profiles[name]!, current),
  );
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return promptListedChoice({
    question: "选择 profile（序号/名称，q 取消）: ",
    match: (answer) => matchListedChoice(names, answer, (name) => name, (name) => name),
    invalidMessage: `未找到 profile，可选: ${names.join(", ")}`,
  });
}

export async function runProfile(name: string | undefined, opts: ProfileCommandOptions): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const config = loadConfig(configPath);
  const configuredDefault = config.default_profile;
  let current: string | undefined;
  if (configuredDefault) {
    current = config.profiles[configuredDefault] ? configuredDefault : undefined;
  } else {
    current = Object.keys(config.profiles)[0];
  }
  terminalStdout.info(
    current
      ? `profile: ${current}\n`
      : `profile: ${configuredDefault} (invalid; profile not found)\n`,
  );
  const selected = name ? resolveProfile(config, name).name : await selectProfile(config, current);

  if (!selected) return;
  if (selected === current) {
    terminalStdout.info(`profile: ${current} (current)\n`);
    return;
  }

  persistDefaultProfile(configPath, selected);
  terminalStdout.success(`profile: ${selected} (saved to ${configPath})\n`);
}
