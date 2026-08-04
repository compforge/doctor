import { terminalStdout } from "../terminal/output";
import { prepareTerminalInput } from "../terminal/input";
import { createInterface } from "node:readline/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { expandHome } from "./config/config";
import { resolveConfigPath } from "./profile";

const INITIAL_PROFILE = "local";
const DEFAULT_KUBECONFIG_PATH = "~/.kube/config";

export interface InitCommandOptions {
  config?: string;
}

type PromptKubeconfigPath = (defaultPath: string) => Promise<string>;

function hasLocalConfig(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").trim().length > 0;
}

function persistInitialConfig(path: string, kubeconfigPath: string): void {
  const next = stringifyYaml({
    default_profile: INITIAL_PROFILE,
    profiles: {
      [INITIAL_PROFILE]: {
        readonly: true,
        kube: { kubeconfig_path: kubeconfigPath },
      },
    },
  });
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, next, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

async function promptKubeconfigPath(defaultPath: string): Promise<string> {
  prepareTerminalInput();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`Kubeconfig path [${defaultPath}]: `)).trim();
    return answer || defaultPath;
  } finally {
    readline.close();
  }
}

export async function runInit(
  opts: InitCommandOptions,
  prompt: PromptKubeconfigPath = promptKubeconfigPath,
): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  if (hasLocalConfig(configPath)) {
    terminalStdout.warning(`config 已存在，跳过初始化: ${configPath}\n`);
    return;
  }

  const kubeconfigPath = await prompt(DEFAULT_KUBECONFIG_PATH);
  if (!existsSync(expandHome(kubeconfigPath))) {
    throw new Error(`kubeconfig path not found: ${kubeconfigPath}`);
  }
  persistInitialConfig(configPath, kubeconfigPath);
  terminalStdout.success(`profile: ${INITIAL_PROFILE} (saved to ${configPath})\n`);
}
