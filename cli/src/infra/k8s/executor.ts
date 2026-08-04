// KubectlExecutor：doctor 访问 Kubernetes 的统一执行通道。
// 只负责传输语义——argv 组装（数组形式，无 shell 拼接注入面）、stdin 送入、
// 超时、退出码与 stdout/stderr 捕获；不理解任何诊断领域语义。

import { spawnProcess, type RuntimeProcess } from "../host/process";

export interface KubectlOptions {
  /** 省略时不加 -n（doctor trace 的 svc 发现需要跨 namespace / -A 查询） */
  namespace?: string;
  kubeconfig?: string;
  context?: string;
}

export interface ExecTarget {
  pod: string;
  container?: string;
}

export interface RunOptions {
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  /** 原始 stdout chunk；用于大体量证据直接落盘，避免先拼成一个内存字符串。 */
  onStdoutBytes?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: string) => void;
  /** 默认保留完整 stdout；流式采集可关闭，避免同一份证据同时占用内存和磁盘。 */
  collectStdout?: boolean;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** 完整 argv，原样记录进 evidence manifest，保证采集可复现可审计 */
  command: string[];
}

/** 诊断步骤面对的执行接口；测试里用脚本化 mock 替换 KubectlExecutor。 */
export interface Executor {
  run(sub: string[], opts?: RunOptions): Promise<ExecResult>;
  exec(target: ExecTarget, cmd: string[], opts?: RunOptions): Promise<ExecResult>;
}

export function buildKubectlArgs(opts: KubectlOptions, sub: string[]): string[] {
  const args = ["kubectl"];
  if (opts.kubeconfig) args.push("--kubeconfig", opts.kubeconfig);
  if (opts.context) args.push("--context", opts.context);
  if (opts.namespace) args.push("-n", opts.namespace);
  return [...args, ...sub];
}

export function buildExecArgs(
  opts: KubectlOptions,
  target: ExecTarget,
  cmd: string[],
  interactive: boolean,
): string[] {
  const sub = ["exec"];
  if (interactive) sub.push("-i");
  sub.push(target.pod);
  if (target.container) sub.push("-c", target.container);
  sub.push("--", ...cmd);
  return buildKubectlArgs(opts, sub);
}

const DEFAULT_TIMEOUT_MS = 30_000;

async function readOutput(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => void,
  onBytes?: (chunk: Uint8Array) => void,
  collect = true,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = collect || onChunk ? new TextDecoder() : undefined;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onBytes?.(value);
    if (decoder) {
      const chunk = decoder.decode(value, { stream: true });
      if (collect) output += chunk;
      onChunk?.(chunk);
    }
  }
  const tail = decoder?.decode() ?? "";
  if (collect) output += tail;
  if (tail) onChunk?.(tail);
  return output;
}

export async function runArgv(argv: string[], opts?: RunOptions): Promise<ExecResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  let proc: RuntimeProcess;
  try {
    proc = spawnProcess(argv, { stdin: opts?.stdin });
  } catch (err) {
    // 二进制不存在（如现场没装 kubectl）走这里，不抛给上层——采集流程按步骤降级
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
      timedOut: false,
      command: argv,
    };
  }

  let timedOut = false;
  let aborted = false;
  const abort = () => {
    aborted = true;
    proc.kill();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  if (opts?.signal?.aborted) abort();
  else opts?.signal?.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readOutput(proc.stdout, opts?.onStdout, opts?.onStdoutBytes, opts?.collectStdout ?? true),
      readOutput(proc.stderr, opts?.onStderr),
      proc.exited,
    ]);
    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      stdout,
      stderr: timedOut
        ? `${stderr}\n[timeout after ${timeoutMs}ms]`.trim()
        : aborted
          ? `${stderr}\n[aborted]`.trim()
          : stderr,
      durationMs: Date.now() - started,
      timedOut,
      command: argv,
    };
  } catch (err) {
    // Node 在可执行文件不存在时异步发出 error；保持原有“步骤不可用而非整条采集抛错”的契约。
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
      timedOut,
      command: argv,
    };
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", abort);
  }
}

export class KubectlExecutor implements Executor {
  constructor(private readonly opts: KubectlOptions) {}

  run(sub: string[], opts?: RunOptions): Promise<ExecResult> {
    return runArgv(buildKubectlArgs(this.opts, sub), opts);
  }

  exec(target: ExecTarget, cmd: string[], opts?: RunOptions): Promise<ExecResult> {
    // stdin 有内容才需要 -i（探针经 stdin 送入目标容器，不落盘不残留）
    return runArgv(buildExecArgs(this.opts, target, cmd, opts?.stdin !== undefined), opts);
  }
}
