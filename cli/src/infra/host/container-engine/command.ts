import { execFile } from "node:child_process";
import type {
  LocalCommandOptions,
  LocalCommandResult,
} from "./model";

const COMMAND_OUTPUT_LIMIT = 8 * 1024 * 1024;

export function runLocalCommand(
  argv: readonly string[],
  options: LocalCommandOptions = {},
): Promise<LocalCommandResult> {
  if (!argv.length) throw new Error("local command argv cannot be empty");
  return new Promise((done) => {
    execFile(
      argv[0]!,
      argv.slice(1),
      {
        encoding: "utf-8",
        env: options.env,
        maxBuffer: COMMAND_OUTPUT_LIMIT,
        timeout: options.timeoutMs ?? 30_000,
      },
      (error, stdout, stderr) => {
        const detail = error as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
        };
        done({
          ok: !error,
          exitCode: typeof detail?.code === "number" ? detail.code : error ? undefined : 0,
          stdout,
          stderr,
          timedOut: Boolean(error && detail.killed),
          errorCode: typeof detail?.code === "string" ? detail.code : undefined,
        });
      },
    );
  });
}
