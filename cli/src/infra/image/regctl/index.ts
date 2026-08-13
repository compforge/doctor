import { terminalStdout, terminalStderr } from "../../../terminal/output";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  hostProcessToolkitChannel,
  resolveDevelopmentToolkitTool,
  resolveToolkitResource,
} from "../../toolkit";
import type {
  ImagePlatform,
  ImageRegistry,
  RegistryCredentials,
  RegistryImageState,
  RegistryTagListResult,
} from "../registry";

export interface RegistryCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

function platformAssetName(): string {
  return `doctor-regctl-${process.platform}-${process.arch}`;
}

function sourceAssetName(): string {
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `regctl-${process.platform}-${arch}`;
}

/** Prefer the independently versioned Toolkit; adjacent binaries and PATH remain operator fallbacks. */
export function resolveRegctlCommand(): string {
  const channel = hostProcessToolkitChannel();
  if (channel) {
    const packaged = resolveToolkitResource(channel, "tool", "regctl");
    if (packaged) return packaged.path;
    const development = resolveDevelopmentToolkitTool("regctl", channel.platform);
    if (development) return development;
  }
  const executableDir = dirname(process.execPath);
  const entryDir = dirname(process.argv[1] ?? process.execPath);
  const candidates = [
    join(executableDir, "doctor-regctl"),
    join(executableDir, platformAssetName()),
    join(entryDir, "doctor-regctl"),
    join(entryDir, platformAssetName()),
    join(process.cwd(), "toolkit", "assets", "regctl", sourceAssetName()),
  ];
  return candidates.find(existsSync) ?? "regctl";
}

function authEnvironment(credentials: RegistryCredentials | undefined): NodeJS.ProcessEnv {
  if (!credentials) return process.env;
  return {
    ...process.env,
    // regclient natively reads this Docker-compatible variable. The secret never enters argv/logs.
    DOCKER_AUTH_CONFIG: JSON.stringify({
      auths: {
        [credentials.registry]: {
          username: credentials.username,
          password: credentials.password,
        },
      },
    }),
  };
}

export function runRegctl(
  args: string[],
  options: { credentials?: RegistryCredentials; quiet?: boolean; timeoutMs?: number } = {},
): RegistryCommandResult {
  const command = resolveRegctlCommand();
  if (!options.quiet) terminalStdout.write(`[debug] regctl ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    env: authEnvironment(options.credentials),
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeoutMs ?? 10 * 60_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? result.error?.message ?? "";
  if (!options.quiet && stdout) terminalStdout.write(stdout);
  if (!options.quiet && stderr) terminalStderr.error(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  return {
    ok: result.status === 0,
    stdout,
    stderr,
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
  };
}

export function classifyRegistryImageResult(result: RegistryCommandResult): RegistryImageState {
  if (result.ok) return "ready";
  if (result.errorCode === "ENOENT" || result.errorCode === "EACCES") return "tool-unavailable";
  const detail = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (/\bclient ip\b.*\b(?:is\s+)?forbidden\b/.test(detail)) return "ip-forbidden";
  if (/unauthorized|authentication required|denied|forbidden/.test(detail)) return "unauthorized";
  if (/manifest unknown|not found|no such manifest|name unknown/.test(detail)) return "missing";
  if (/timeout|timed out|dial tcp|connection refused|no such host|tls|x509|network is unreachable/.test(detail)) {
    return "unreachable";
  }
  return "registry-error";
}

export function parseImagePlatform(value: string): ImagePlatform | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "linux/amd64") return { os: "linux", architecture: "amd64" };
  if (normalized === "linux/arm64") return { os: "linux", architecture: "arm64" };
  return undefined;
}

export function parseRegistryTagListResult(result: RegistryCommandResult): RegistryTagListResult {
  if (!result.ok) return { state: classifyRegistryImageResult(result), tags: [] };
  try {
    const tags = JSON.parse(result.stdout) as unknown;
    return Array.isArray(tags) && tags.every((tag) => typeof tag === "string")
      ? { state: "ready", tags: [...new Set(tags)] }
      : { state: "registry-error", tags: [] };
  } catch {
    return { state: "registry-error", tags: [] };
  }
}

export const regctlImageRegistry: ImageRegistry = {
  inspect(image, credentials, platform) {
    const args = ["manifest", "head", image];
    if (platform) args.push("--platform", `${platform.os}/${platform.architecture}`);
    return classifyRegistryImageResult(
      runRegctl(args, { credentials, quiet: true, timeoutMs: 15_000 }),
    );
  },
  inspectPlatform(image, credentials) {
    const result = runRegctl(
      ["image", "inspect", image, "--format", "{{.OS}}/{{.Architecture}}"],
      { credentials, quiet: true, timeoutMs: 30_000 },
    );
    if (!result.ok) return { state: classifyRegistryImageResult(result) };
    const platform = parseImagePlatform(result.stdout);
    return platform ? { state: "ready", platform } : { state: "registry-error" };
  },
  listTags(repository, credentials) {
    const result = runRegctl(
      ["tag", "ls", repository, "--limit", "100", "--format", "{{json .Tags}}"],
      { credentials, quiet: true, timeoutMs: 30_000 },
    );
    return parseRegistryTagListResult(result);
  },
  import(image, archive, credentials, options) {
    const args = ["image", "import"];
    if (options?.sourceImage) args.push("--name", options.sourceImage);
    args.push(image, archive);
    return runRegctl(args, { credentials }).ok;
  },
  createIndex(image, refs, credentials) {
    const args = ["index", "create", image];
    for (const ref of refs) args.push("--ref", ref);
    return runRegctl(args, { credentials, timeoutMs: 2 * 60_000 }).ok;
  },
  verifyIndex(image, credentials) {
    return runRegctl(["manifest", "head", image, "--require-list"], {
      credentials,
      timeoutMs: 15_000,
    }).ok;
  },
};
