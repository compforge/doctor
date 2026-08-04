export type LocalContainerEngineName = "docker" | "podman" | "nerdctl";

export interface LocalCommandResult {
  ok: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode?: string;
}

export interface LocalCommandOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type LocalCommandRunner = (
  argv: readonly string[],
  options?: LocalCommandOptions,
) => Promise<LocalCommandResult>;

export interface LocalContainerEngine {
  name: LocalContainerEngineName;
  run: LocalCommandRunner;
}
