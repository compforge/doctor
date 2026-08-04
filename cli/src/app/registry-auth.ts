import { terminalStdout } from "../terminal/output";
import { prepareTerminalInput } from "../terminal/input";
import { createInterface, emitKeypressEvents } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveProfile } from "./config/config";
import { infra } from "../infra";
import type {
  ImagePlatform,
  RegistryCredentials,
  RegistryImageState,
  RegistryTagListResult,
} from "../infra/image";

export interface RegistryAuthOpts {
  profile?: string;
  config?: string;
}

export type RegistryAuthPurpose = "list-tags" | "inspect-image" | "publish-image";

interface RegistryTagListOptions {
  promptIfUnauthorized?: boolean;
}

function registryFromImage(image: string): string {
  const registry = image.split("/", 1)[0]?.trim();
  if (!registry || (registry !== "localhost" && !/[.:]/.test(registry))) {
    throw new Error(`目标镜像没有显式 registry：${image}`);
  }
  return registry;
}

export function resolveProfileRegistryCredentials(
  image: string,
  opts: RegistryAuthOpts,
): RegistryCredentials | undefined {
  const configPath = opts.config ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
  const { profile } = resolveProfile(loadConfig(configPath), opts.profile);
  const username = profile.registry?.username?.trim();
  const password = profile.registry?.password;
  if (!username && !password) return undefined;
  if (!username || !password) {
    throw new Error("profile registry.username / registry.password 必须成对配置");
  }
  return { registry: registryFromImage(image), username, password };
}

async function promptLine(question: string, defaultValue?: string): Promise<string | undefined> {
  prepareTerminalInput();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => {
      readline.question(question, (answer) => resolve(answer.trim() || defaultValue));
    });
  } finally {
    readline.close();
  }
}

async function promptSecret(question: string): Promise<string | undefined> {
  const input = process.stdin;
  if (!input.isTTY || !input.setRawMode) return undefined;
  prepareTerminalInput(input);
  terminalStdout.write(question);
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  return await new Promise((resolve) => {
    let value = "";
    const finish = (result: string | undefined) => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      terminalStdout.write("\n");
      resolve(result);
    };
    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") return finish(undefined);
      if (key.name === "return" || key.name === "enter") return finish(value || undefined);
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && text && !text.startsWith("\u001b")) value += text;
    };
    input.on("keypress", onKeypress);
  });
}

async function promptRegistryCredentials(
  registry: string,
  target: string,
  purpose: RegistryAuthPurpose,
  defaultUsername?: string,
): Promise<RegistryCredentials | undefined> {
  const explanation = purpose === "list-tags"
    ? `doctor debug 正在读取 ${target} 的 tag 列表，以选择已发布的 debug image。`
    : purpose === "publish-image"
      ? `doctor image 正在检查目标 ${target} 的访问权限；认证通过后会把所选 tar 发布到这个地址。`
      : `doctor debug 正在检查 ${target} 是否可从 registry 拉取。`;
  const credentialUsage = purpose === "publish-image"
    ? "用户名和密码用于本次检查和上传，不会保存到 profile。"
    : "用户名和密码仅用于本次读取，不会上传 image，也不会保存到 profile。";
  terminalStdout.info(`[registry] ${explanation}\n[registry] Registry 要求认证；${credentialUsage}\n`);
  const username = await promptLine(
    `Registry 用户名${defaultUsername ? `（回车使用 ${defaultUsername}）` : "（回车跳过）"}：`,
    defaultUsername,
  );
  if (!username) return undefined;
  const password = await promptSecret("Registry 密码（输入不回显，回车跳过）：");
  return password ? { registry, username, password } : undefined;
}

export async function inspectRegistryAccess(
  image: string,
  opts: RegistryAuthOpts,
  platform?: ImagePlatform,
  purpose: Exclude<RegistryAuthPurpose, "list-tags"> = "inspect-image",
): Promise<{ state: RegistryImageState; credentials?: RegistryCredentials }> {
  const registry = registryFromImage(image);
  let credentials = resolveProfileRegistryCredentials(image, opts);
  let state = infra.image.inspect(image, credentials, platform);
  if (state !== "unauthorized" || !process.stdin.isTTY || !process.stdout.isTTY) {
    return { state, credentials };
  }
  const prompted = await promptRegistryCredentials(registry, image, purpose, credentials?.username);
  if (!prompted) return { state, credentials };
  credentials = prompted;
  state = infra.image.inspect(image, credentials, platform);
  return { state, credentials };
}

export async function listRegistryTagsWithAuth(
  repository: string,
  opts: RegistryAuthOpts,
  options: RegistryTagListOptions = {},
): Promise<RegistryTagListResult & { credentials?: RegistryCredentials }> {
  const registry = registryFromImage(repository);
  let credentials = resolveProfileRegistryCredentials(repository, opts);
  let result = infra.image.listTags(repository, credentials);
  if (
    result.state !== "unauthorized"
    || options.promptIfUnauthorized === false
    || !process.stdin.isTTY
    || !process.stdout.isTTY
  ) {
    return { ...result, credentials };
  }
  const prompted = await promptRegistryCredentials(
    registry,
    repository,
    "list-tags",
    credentials?.username,
  );
  if (!prompted) return { ...result, credentials };
  credentials = prompted;
  result = infra.image.listTags(repository, credentials);
  return { ...result, credentials };
}
