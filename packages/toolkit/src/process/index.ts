import { spawn } from "node:child_process";
import { Readable } from "node:stream";

export interface RuntimeProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface SpawnProcessOptions {
  stdin?: string | Uint8Array;
  env?: NodeJS.ProcessEnv;
}

/** Doctor Host 子进程统一走 Node-compatible API，避免 collect domain 绑定 Bun.*。 */
export function spawnProcess(argv: string[], opts?: SpawnProcessOptions): RuntimeProcess {
  if (!argv.length) throw new Error("command argv cannot be empty");

  const child = spawn(argv[0], argv.slice(1), {
    stdio: "pipe",
    env: opts?.env,
  });
  child.stdin.end(opts?.stdin);

  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  return {
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    exited,
    kill: () => child.kill(),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
